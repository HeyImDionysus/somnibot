import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
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
import { getDiscordOAuthRuntimeConfig } from '@/lib/discord-runtime-config';
import { getInstallationRuntimeSecret } from '@/lib/installation-runtime-secret';
import { ensureDiscordAuthProvider } from '@/lib/supabase/auto-config';
import {
  ALLOWED_SETTING_KEYS,
  BOOTSTRAP_ONLY_FIELDS,
  ENCRYPTED_SECRET_FIELDS,
  normalizeInstallationSettingValue,
  claimInstallationSettingsWriteLease,
  readInstallationSettings,
  releaseInstallationSettingsWriteLease,
  SETTING_SECTIONS,
} from '@/lib/installation-settings';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;
const DISCORD_SETTINGS_LEASE_SCOPE = 'discord-auth-settings';
const DISCORD_MANAGEMENT_TIMEOUT_MS = 30_000;

async function withDiscordSettingsWriteLease(
  admin: AdminSupabase,
  operation: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const operationId = randomUUID();
  const claimed = await claimInstallationSettingsWriteLease(
    admin,
    DISCORD_SETTINGS_LEASE_SCOPE,
    operationId,
  );
  if (!claimed) {
    return NextResponse.json(
      { error: 'Discord login settings are already being changed. Wait for that change to finish and retry.' },
      { status: 409 },
    );
  }

  try {
    return await operation();
  } finally {
    try {
      await releaseInstallationSettingsWriteLease(
        admin,
        DISCORD_SETTINGS_LEASE_SCOPE,
        operationId,
      );
    } catch (releaseError) {
      console.error('[Settings] Discord settings write lease release failed:', releaseError);
    }
  }
}

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
    const submittedEntries = Object.entries(values)
      .filter(([, value]) => !value.includes('••••') && value.trim() !== '');
    const unsupportedKey = submittedEntries.find(([key]) => !ALLOWED_SETTING_KEYS.has(key))?.[0];
    if (unsupportedKey) {
      return NextResponse.json(
        { error: `Unsupported installation setting: ${unsupportedKey}` },
        { status: 400 },
      );
    }
    const sectionMismatch = submittedEntries.find(([key]) => SETTING_SECTIONS[key] !== section)?.[0];
    if (sectionMismatch) {
      return NextResponse.json(
        { error: `${sectionMismatch} does not belong to the ${section} settings section` },
        { status: 400 },
      );
    }
    const bootstrapKey = submittedEntries.find(([key]) => BOOTSTRAP_ONLY_FIELDS.has(key))?.[0];
    if (bootstrapKey) {
      return NextResponse.json(
        { error: 'Supabase bootstrap settings must be changed in the deployment configuration.' },
        { status: 400 },
      );
    }
    const writableEntries: Array<[string, string]> = [];
    for (const [key, value] of submittedEntries) {
      const normalized = normalizeInstallationSettingValue(key, value);
      if (!normalized.ok) {
        return NextResponse.json({ error: normalized.error }, { status: 400 });
      }
      writableEntries.push([key, normalized.value]);
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
    const nextPayPalSecret = writableEntries.find(([key]) => key === 'paypal_client_secret')?.[1];
    if (nextPayPalSecret && bootstrapSecret && projectOrigin) {
      const previousPayPalSecret = await getInstallationRuntimeSecret(
        'paypal_client_secret',
        ['PAYPAL_CLIENT_SECRET'],
      );
      if (previousPayPalSecret && previousPayPalSecret !== nextPayPalSecret) {
        upsertRows.push({
          ...encryptCloudCredential(
            previousPayPalSecret,
            'paypal_client_secret_v1_previous',
            bootstrapSecret,
            projectOrigin,
          ),
          section: 'paypal',
          updated_at: now,
        });
      }
    }

    if (upsertRows.length === 0) {
      return NextResponse.json(
        { error: 'No writable settings were supplied' },
        { status: 400 },
      );
    }

    const updatesDiscordAuth = writableEntries.some(([key]) => (
      key === 'discord_application_id' || key === 'discord_client_secret'
    ));
    const persistSettings = async (): Promise<NextResponse> => {
      let previousDiscordConfig: Awaited<ReturnType<typeof getDiscordOAuthRuntimeConfig>> | null = null;
      let managementAccessToken = '';
      if (updatesDiscordAuth) {
        previousDiscordConfig = await getDiscordOAuthRuntimeConfig();
        const submitted = new Map(writableEntries);
        const nextApplicationId = submitted.get('discord_application_id') ?? previousDiscordConfig.applicationId;
        const nextClientSecret = submitted.get('discord_client_secret') ?? previousDiscordConfig.clientSecret;
        if (!nextApplicationId || !nextClientSecret) {
          return NextResponse.json(
            { error: 'Discord Application ID and OAuth2 Client Secret are both required to update dashboard login.' },
            { status: 400 },
          );
        }
        managementAccessToken = await getInstallationRuntimeSecret(
          'supabase_access_token',
          ['SUPABASE_ACCESS_TOKEN'],
        );
        const providerUpdate = await ensureDiscordAuthProvider({
          accessToken: managementAccessToken,
          discordClientId: nextApplicationId,
          discordClientSecret: nextClientSecret,
          forceCredentialUpdate: true,
          timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
        });
        if (!providerUpdate.success) {
          const rollback = await ensureDiscordAuthProvider({
            accessToken: managementAccessToken,
            discordClientId: previousDiscordConfig.applicationId,
            discordClientSecret: previousDiscordConfig.clientSecret,
            forceCredentialUpdate: true,
            timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
          });
          if (!rollback.success) {
            console.error('[Settings] Discord Auth rollback could not be verified after provider verification failed');
          }
          return NextResponse.json(
            { error: `Discord login credentials were not changed: ${providerUpdate.error ?? 'Supabase Auth rejected the update.'}` },
            { status: 409 },
          );
        }
      }

      const { error: upsertError } = await admin
        .from('instance_settings')
        .upsert(upsertRows, { onConflict: 'key' });
      if (upsertError) {
        if (previousDiscordConfig?.applicationId && previousDiscordConfig.clientSecret) {
          const rollback = await ensureDiscordAuthProvider({
            accessToken: managementAccessToken,
            discordClientId: previousDiscordConfig.applicationId,
            discordClientSecret: previousDiscordConfig.clientSecret,
            forceCredentialUpdate: true,
            timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
          });
          if (!rollback.success) {
            console.error('[Settings] Discord Auth rollback could not be verified after the settings write failed');
          }
        }
        return dbError(upsertError, 'settings');
      }

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
    };

    return updatesDiscordAuth
      ? await withDiscordSettingsWriteLease(admin, persistSettings)
      : await persistSettings();
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
    const resetsDiscordAuth = keys.some((key) => (
      key === 'discord_application_id' || key === 'discord_client_secret'
    ));
    const resetSavedSettings = async (): Promise<NextResponse> => {
      let previousDiscordConfig: Awaited<ReturnType<typeof getDiscordOAuthRuntimeConfig>> | null = null;
      let managementAccessToken = '';
      if (resetsDiscordAuth) {
        previousDiscordConfig = await getDiscordOAuthRuntimeConfig();
        const nextApplicationId = keys.includes('discord_application_id')
          ? process.env.DISCORD_APPLICATION_ID?.trim() ?? ''
          : previousDiscordConfig.applicationId;
        const nextClientSecret = keys.includes('discord_client_secret')
          ? process.env.DISCORD_CLIENT_SECRET?.trim() ?? ''
          : previousDiscordConfig.clientSecret;
        const applicationIdValidation = normalizeInstallationSettingValue(
          'discord_application_id',
          nextApplicationId,
        );
        if (!applicationIdValidation.ok || !nextClientSecret) {
          return NextResponse.json(
            { error: 'Discord deployment defaults are incomplete or malformed, so dashboard login settings were not reset.' },
            { status: 409 },
          );
        }
        managementAccessToken = await getInstallationRuntimeSecret(
          'supabase_access_token',
          ['SUPABASE_ACCESS_TOKEN'],
        );
        const providerUpdate = await ensureDiscordAuthProvider({
          accessToken: managementAccessToken,
          discordClientId: applicationIdValidation.value,
          discordClientSecret: nextClientSecret,
          forceCredentialUpdate: true,
          timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
        });
        if (!providerUpdate.success) {
          const rollback = await ensureDiscordAuthProvider({
            accessToken: managementAccessToken,
            discordClientId: previousDiscordConfig.applicationId,
            discordClientSecret: previousDiscordConfig.clientSecret,
            forceCredentialUpdate: true,
            timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
          });
          if (!rollback.success) {
            console.error('[Settings] Discord Auth rollback could not be verified after reset verification failed');
          }
          return NextResponse.json(
            { error: `Discord login credentials were not reset: ${providerUpdate.error ?? 'Supabase Auth rejected the deployment defaults.'}` },
            { status: 409 },
          );
        }
      }
      if (keys.includes('paypal_client_secret')) {
        const bootstrapSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
        const projectOrigin = supabaseUrl ? new URL(supabaseUrl).origin : '';
        if (!bootstrapSecret || !projectOrigin) {
          return NextResponse.json(
            { error: 'Supabase bootstrap credentials are required to preserve outstanding checkout signatures.' },
            { status: 409 },
          );
        }
        const outgoingPayPalSecret = await getInstallationRuntimeSecret(
          'paypal_client_secret',
          ['PAYPAL_CLIENT_SECRET'],
        );
        if (outgoingPayPalSecret) {
          const retained = encryptCloudCredential(
            outgoingPayPalSecret,
            'paypal_client_secret_v1_previous',
            bootstrapSecret,
            projectOrigin,
          );
          const { error: preserveError } = await admin
            .from('instance_settings')
            .upsert(
              { ...retained, section: 'paypal', updated_at: new Date().toISOString() },
              { onConflict: 'key' },
            );
          if (preserveError) return dbError(preserveError, 'settings');
        }
      }
      const { error } = await admin
        .from('instance_settings')
        .delete()
        .in('key', storageKeys);
      if (error) {
        if (previousDiscordConfig?.applicationId && previousDiscordConfig.clientSecret) {
          const rollback = await ensureDiscordAuthProvider({
            accessToken: managementAccessToken,
            discordClientId: previousDiscordConfig.applicationId,
            discordClientSecret: previousDiscordConfig.clientSecret,
            forceCredentialUpdate: true,
            timeoutMs: DISCORD_MANAGEMENT_TIMEOUT_MS,
          });
          if (!rollback.success) {
            console.error('[Settings] Discord Auth rollback could not be verified after reset storage failed');
          }
        }
        return dbError(error, 'settings');
      }

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
    };

    return resetsDiscordAuth
      ? await withDiscordSettingsWriteLease(admin, resetSavedSettings)
      : await resetSavedSettings();
  } catch (err) {
    console.error('[Settings] Reset error:', err);
    return NextResponse.json({ error: 'Failed to reset settings' }, { status: 500 });
  }
}
