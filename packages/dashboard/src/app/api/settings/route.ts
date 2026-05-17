import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

/**
 * Settings API — read and write operator configuration.
 * 
 * Settings are stored in the `instance_settings` table in Supabase.
 * Each setting has a section (supabase, discord, paypal, etc.) and key/value pairs.
 * Secret values are masked when returned to the client.
 */

const SECRET_FIELDS = new Set([
  'supabase_anon_key',
  'supabase_service_role_key',
  'discord_bot_token',
  'discord_client_secret',
  'paypal_client_secret',
  'lavalink_password',
]);

function maskValue(value: string): string {
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

/**
 * GET /api/settings — Load all settings with masked secrets.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminSupabase();

    // Try to read from instance_settings table
    const { data: settings, error } = await admin
      .from('instance_settings')
      .select('key, value, section')
      .order('section');

    if (error) {
      // Table might not exist yet — return empty defaults
      console.error('[Settings] Read error:', error.message);
      return NextResponse.json({ values: {}, statuses: {} });
    }

    const values: Record<string, string> = {};
    const sections = new Set<string>();

    for (const row of settings || []) {
      sections.add(row.section);
      if (SECRET_FIELDS.has(row.key) && row.value) {
        values[row.key] = maskValue(row.value);
      } else {
        values[row.key] = row.value || '';
      }
    }

    // Determine connection statuses based on which sections have values
    const statuses: Record<string, string> = {};
    for (const section of ['supabase', 'discord', 'paypal', 'lavalink', 'valkey']) {
      const sectionSettings = (settings || []).filter(
        (s) => s.section === section && s.value
      );
      statuses[section] = sectionSettings.length > 0 ? 'connected' : 'disconnected';
    }

    return NextResponse.json({ values, statuses });
  } catch (err) {
    console.error('[Settings] Error:', err);
    return NextResponse.json({ values: {}, statuses: {} });
  }
}

/**
 * PUT /api/settings — Save settings for a section.
 */
export async function PUT(request: Request) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { section, values } = body as { section: string; values: Record<string, string> };

    if (!section || !values) {
      return NextResponse.json({ error: 'Missing section or values' }, { status: 400 });
    }

    const admin = createAdminSupabase();

    // Upsert each setting
    for (const [key, value] of Object.entries(values)) {
      // Skip masked values (user didn't change them)
      if (value.includes('••••')) continue;

      await admin
        .from('instance_settings')
        .upsert(
          { key, value, section, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
    }

    return NextResponse.json({
      ok: true,
      status: Object.values(values).some((v) => v && !v.includes('••••')) ? 'connected' : 'disconnected',
    });
  } catch (err) {
    console.error('[Settings] Save error:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
