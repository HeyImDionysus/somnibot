import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { apiServerError, dbError } from '@/lib/api/response';
import { recordAdminChange, humanizeColumn } from '@/lib/admin-changes';
import { isSoleInstanceOperator } from '@/app/api/webhooks/scope';
import { encryptCloudCredential } from '@/lib/cloud-credential-crypto';
import {
  ALLOWED_SETTING_KEYS,
  BOOTSTRAP_ONLY_FIELDS,
  ENCRYPTED_SECRET_FIELDS,
  readInstallationSettings,
  SETTING_SECTIONS,
} from '@/lib/installation-settings';

const settingsUpdate = z.object({
  section: z.string().min(1).max(64),
  values: z.record(z.string().max(4096)),
});

const settingsReset = z.object({
  section: z.string().min(1).max(64),
  keys: z.array(z.string().min(1).max(128)).min(1).max(32),
});

export async function GET() {
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    return NextResponse.json(await readInstallationSettings(admin));
  } catch (err) {
    return apiServerError(err, 'GET /api/settings');
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    const parsed = await parseBody(request, settingsUpdate);
    if (!parsed.ok) return parsed.response;
    const { section, values } = parsed.data;

    // V10 Audit §6: Batch all upserts into a single operation to avoid
    // sequential timing that leaks info about which keys were skipped.
    const now = new Date().toISOString();
    const writableEntries = Object.entries(values)
      .filter(([, value]) => !value.includes('••••') && value.trim() !== '');
    const unsupportedKey = writableEntries.find(([key]) => !ALLOWED_SETTING_KEYS.has(key))?.[0];
    if (unsupportedKey) {
      return NextResponse.json(
        { error: `Unsupported installation setting: ${unsupportedKey}` },
        { status: 400 },
      );
    }
    const sectionMismatch = writableEntries.find(([key]) => SETTING_SECTIONS[key] !== section)?.[0];
    if (sectionMismatch) {
      return NextResponse.json(
        { error: `${sectionMismatch} does not belong to the ${section} settings section` },
        { status: 400 },
      );
    }
    const bootstrapKey = writableEntries.find(([key]) => BOOTSTRAP_ONLY_FIELDS.has(key))?.[0];
    if (bootstrapKey) {
      return NextResponse.json(
        { error: 'Supabase bootstrap settings must be changed in the deployment configuration.' },
        { status: 400 },
      );
    }
    for (const [key, value] of writableEntries) {
      if (['auto_install_on_quit', 'keychain_required', 'lavalink_enabled', 'update_prompt_before_download'].includes(key) && value !== 'true' && value !== 'false') {
        return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
      }
      if (key === 'runtime_mode' && !['regular-local', 'vps', 'development'].includes(value)) {
        return NextResponse.json({ error: 'runtime_mode is invalid' }, { status: 400 });
      }
      if (key === 'sdk_cache_ttl_ms' && (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 3600000)) {
        return NextResponse.json({ error: 'sdk_cache_ttl_ms must be between 1000 and 3600000' }, { status: 400 });
      }
      if (key === 'owner_brand_name' && value.length > 128) {
        return NextResponse.json({ error: 'owner_brand_name is too long' }, { status: 400 });
      }
      if (key === 'vps_deploy_path' && value.length > 512) {
        return NextResponse.json({ error: 'vps_deploy_path is too long' }, { status: 400 });
      }
    }
    const bootstrapSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const projectOrigin = supabaseUrl ? new URL(supabaseUrl).origin : '';
    const upsertRows = writableEntries.map(([key, value]) => {
      if (!ENCRYPTED_SECRET_FIELDS.has(key)) return { key, value, section, updated_at: now };
      if (!bootstrapSecret || !projectOrigin) {
        throw new Error('Supabase bootstrap credentials are required to encrypt settings.');
      }
      const encrypted = encryptCloudCredential(value, key, bootstrapSecret, projectOrigin);
      return { ...encrypted, section, updated_at: now };
    });

    if (upsertRows.length === 0) {
      return NextResponse.json(
        { error: 'No writable settings were supplied' },
        { status: 400 },
      );
    }

    const { error: upsertError } = await admin
      .from('instance_settings')
      .upsert(upsertRows, { onConflict: 'key' });
    if (upsertError) return dbError(upsertError, 'settings');

    await notifyBot(auth.ctx.guildId, 'settings', { section });

    {
      const changedKeys = upsertRows.map((r) => r.key);
      await recordAdminChange({
        // `instance_settings` is keyed by `key` alone — it has NO guild column
        // and every row applies to the whole installation. `admin_changes` is
        // per-guild and `guild_id` is NOT NULL, so this is filed under the
        // acting owner's active guild (a real guild from the session, never a
        // placeholder) and the sentence says out loud that the change is
        // installation-wide, so nobody reads it as a per-server setting.
        guildId: auth.ctx.guildId,
        actorId: auth.ctx.discordId,
        action: 'instance.settings_updated',
        targetType: 'installation settings',
        targetId: section,
        description:
          `Changed ${changedKeys.length} ${section} connection setting`
          + `${changedKeys.length === 1 ? '' : 's'} `
          + `(${changedKeys.map(humanizeColumn).join(', ')}) for the whole bot installation`,
        // [security] KEY NAMES ONLY — never values, and no before-read.
        // instance_settings is where the Discord bot token, the Supabase
        // service-role key, the PayPal client secret and the Lavalink password
        // live (SECRET_FIELDS above). Copying either the old or the new value
        // into before_state/after_state would replicate every credential of
        // this installation into a table the Admin Changes page renders in
        // full. The names alone are what an owner needs to see.
        after: { section, changed_keys: changedKeys },
        // A wrong bot token or Supabase key takes the entire installation down.
        blastRadius: 'critical',
        undoReason:
          'the previous values are credentials that are deliberately never copied into this log, so there is nothing here to restore them from',
      }, admin);
    }

    return NextResponse.json({
      ok: true,
      restartRequired: true,
      appliesAfter: 'bot-and-dashboard-restart',
    });
  } catch (err) {
    console.error('[Settings] Save error:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    const parsed = await parseBody(request, settingsReset);
    if (!parsed.ok) return parsed.response;
    const { section, keys } = parsed.data;
    const unsupportedKey = keys.find((key) => !ALLOWED_SETTING_KEYS.has(key));
    if (unsupportedKey) {
      return NextResponse.json(
        { error: `Unsupported installation setting: ${unsupportedKey}` },
        { status: 400 },
      );
    }
    const sectionMismatch = keys.find((key) => SETTING_SECTIONS[key] !== section);
    if (sectionMismatch) {
      return NextResponse.json(
        { error: `${sectionMismatch} does not belong to the ${section} settings section` },
        { status: 400 },
      );
    }
    if (keys.some((key) => BOOTSTRAP_ONLY_FIELDS.has(key))) {
      return NextResponse.json(
        { error: 'Supabase bootstrap settings cannot be reset from the dashboard.' },
        { status: 400 },
      );
    }

    const storageKeys = keys.map((key) => (
      ENCRYPTED_SECRET_FIELDS.has(key) ? `${key}_encrypted` : key
    ));
    const { error } = await admin
      .from('instance_settings')
      .delete()
      .in('key', storageKeys);
    if (error) return dbError(error, 'settings');

    await notifyBot(auth.ctx.guildId, 'settings', { section });
    await recordAdminChange({
      guildId: auth.ctx.guildId,
      actorId: auth.ctx.discordId,
      action: 'instance.settings_reset_to_environment',
      targetType: 'installation settings',
      targetId: section,
      description: `Restored ${keys.length} ${section} connection setting${keys.length === 1 ? '' : 's'} to deployment defaults`,
      after: { section, reset_keys: keys },
      blastRadius: 'critical',
      undoReason: 'the previous encrypted values are deliberately not copied into the audit log',
    }, admin);

    return NextResponse.json({
      ok: true,
      restartRequired: true,
      appliesAfter: 'bot-and-dashboard-restart',
    });
  } catch (err) {
    console.error('[Settings] Reset error:', err);
    return NextResponse.json({ error: 'Failed to reset settings' }, { status: 500 });
  }
}
