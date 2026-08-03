/**
 * Credential validators — verify user-provided values via real API calls.
 *
 * Each validator returns { ok: true } or { ok: false, error: string }.
 */

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** Extra data returned on success (e.g. bot username, guild name). */
  meta?: Record<string, string>;
}

export type ProviderValidationCheckId =
  | 'discord-bot-token'
  | 'discord-application'
  | 'discord-client-secret'
  | 'discord-guild'
  | 'supabase-project';

export type ProviderValidationCheckStatus = 'success' | 'failed' | 'skipped';

export interface ProviderValidationCheck {
  id: ProviderValidationCheckId;
  label: string;
  status: ProviderValidationCheckStatus;
  summary: string;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/*  Discord Token                                                      */
/* ------------------------------------------------------------------ */

export async function validateDiscordToken(token: string): Promise<ValidationResult> {
  if (!token.trim()) return { ok: false, error: 'Discord token is required.' };

  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      return { ok: false, error: 'Invalid bot token. Make sure you copied the full token from Discord Developer Portal → Bot → Token.' };
    }
    if (!res.ok) {
      return { ok: false, error: `Discord API returned HTTP ${res.status}. Try again in a moment.` };
    }

    const data = await res.json() as { username: string; id: string };
    return {
      ok: true,
      meta: { botUsername: data.username, botId: data.id },
    };
  } catch (err) {
    return { ok: false, error: `Could not reach Discord API. Check your internet connection.\n${String(err)}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Discord Application ID                                             */
/* ------------------------------------------------------------------ */

export async function validateDiscordAppId(
  appId: string,
  token: string,
): Promise<ValidationResult> {
  if (!appId.trim()) return { ok: false, error: 'Application ID is required.' };

  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${token.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { ok: false, error: `Could not verify Application ID. Discord returned HTTP ${res.status}.` };
    }

    const data = await res.json() as { id: string };
    if (data.id !== appId.trim()) {
      return {
        ok: false,
        error: `Application ID mismatch. Your token belongs to app "${data.id}" but you entered "${appId.trim()}". Use the ID from Discord Developer Portal → General Information → Application ID.`,
      };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not verify Application ID.\n${String(err)}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Discord Guild ID                                                   */
/* ------------------------------------------------------------------ */

/**
 * Validate one or more guild IDs (comma-separated for multi-guild — V53 Phase 4).
 */
export async function validateGuildId(
  guildId: string,
  token: string,
): Promise<ValidationResult> {
  if (!guildId.trim()) {
    // Guild ID is auto-detected — not strictly required at launch
    return { ok: true, meta: { guildName: '(will auto-detect on first join)' } };
  }

  // Support comma-separated guild IDs for multi-guild
  const guildIds = guildId.split(',').map(id => id.trim()).filter(Boolean);
  const names: string[] = [];

  for (const id of guildIds) {
    try {
      const res = await fetch(`https://discord.com/api/v10/guilds/${id}`, {
        headers: { Authorization: `Bot ${token.trim()}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 403 || res.status === 404) {
        return {
          ok: false,
          error: `Bot is not in server ${id}, or the Guild ID is wrong. Make sure the bot has been invited first.`,
        };
      }
      if (!res.ok) {
        return { ok: false, error: `Discord API returned HTTP ${res.status} for guild ${id}.` };
      }

      const data = await res.json() as { name: string };
      names.push(data.name);
    } catch (err) {
      return { ok: false, error: `Could not verify Guild ID ${id}.\n${String(err)}` };
    }
  }

  return { ok: true, meta: { guildName: names.join(', ') } };
}

/* ------------------------------------------------------------------ */
/*  Supabase                                                           */
/* ------------------------------------------------------------------ */

export function validateSupabaseUrl(url: string): ValidationResult {
  if (!url.trim()) return { ok: false, error: 'Supabase URL is required.' };
  try {
    const parsed = new URL(url.trim());
    const isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLocalDev) {
      return { ok: false, error: 'Supabase URL must use HTTPS.' };
    }
    const isSupabaseDomain = parsed.hostname.endsWith('.supabase.co') || parsed.hostname.endsWith('.supabase.com');
    if (!isSupabaseDomain && !isLocalDev) {
      return {
        ok: false,
        error: 'Supabase URL must be a *.supabase.co domain or localhost. Got: ' + parsed.hostname,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid Supabase URL. Expected something like "https://your-project.supabase.co".' };
  }
}

export async function validateSupabase(
  url: string,
  secretKey: string,
  publishableKey: string,
): Promise<ValidationResult> {
  if (!url.trim()) return { ok: false, error: 'Supabase URL is required.' };
  if (!secretKey.trim()) return { ok: false, error: 'Supabase Secret Key is required.' };
  if (!publishableKey.trim()) return { ok: false, error: 'Supabase Publishable Key is required.' };

  const urlValidation = validateSupabaseUrl(url);
  if (!urlValidation.ok) return urlValidation;

  // Verify secret key by calling the health endpoint with auth
  try {
    const res = await fetch(`${url.trim()}/rest/v1/`, {
      headers: {
        apikey: secretKey.trim(),
        Authorization: `Bearer ${secretKey.trim()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Supabase Secret Key is invalid. Copy the "service_role"/"secret" key from Supabase → Settings → API → Project API keys.' };
    }
    // 200 means REST endpoint is reachable — good enough
  } catch (err) {
    return { ok: false, error: `Could not reach Supabase at ${url.trim()}. Check the URL and your internet connection.\n${String(err)}` };
  }

  // Verify publishable key — use the auth health endpoint which accepts anon keys
  // regardless of PostgREST schema permissions (the anon role may get 403 from
  // /rest/v1/ on projects with restricted permissions, which is normal).
  try {
    const trimmedPubKey = publishableKey.trim();

    // Quick format check — Supabase keys are either:
    //   - Legacy JWTs starting with "eyJ..."
    //   - New format starting with "sb_publishable_..." or "sbp_..."
    const looksLikeKey = trimmedPubKey.startsWith('eyJ')
      || trimmedPubKey.startsWith('sb_publishable_')
      || trimmedPubKey.startsWith('sbp_');
    if (!looksLikeKey) {
      return {
        ok: false,
        error: 'Supabase Publishable Key doesn\'t look right. It should be the "anon"/"publishable" key from Supabase → Settings → API (starts with "sb_publishable_..." or "eyJ...").',
      };
    }

    const res = await fetch(`${url.trim()}/auth/v1/settings`, {
      headers: {
        apikey: trimmedPubKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      return {
        ok: false,
        error: 'Supabase Publishable Key is invalid. Copy the "anon"/"public" key from Supabase → Settings → API → Project API keys.',
      };
    }
    // 200 or 403 both mean the key was recognized — 403 just means restricted permissions
  } catch (err) {
    return { ok: false, error: `Could not verify Publishable Key.\n${String(err)}` };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Full validation pipeline                                           */
/* ------------------------------------------------------------------ */

export interface FullValidationResult {
  valid: boolean;
  errors: string[];
  meta: Record<string, string>;
  checks: ProviderValidationCheck[];
}

export async function validateAllCredentials(config: {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
}): Promise<FullValidationResult> {
  const errors: string[] = [];
  const meta: Record<string, string> = {};
  const checks: ProviderValidationCheck[] = [];

  // 1. Discord token (must come first — other Discord checks need it)
  const tokenResult = await validateDiscordToken(config.discordToken);
  if (!tokenResult.ok) {
    errors.push(tokenResult.error!);
    checks.push({
      id: 'discord-bot-token',
      label: 'Discord bot token',
      status: 'failed',
      summary: 'Discord bot token could not be verified.',
      detail: tokenResult.error,
    });
    checks.push({
      id: 'discord-application',
      label: 'Discord application',
      status: 'skipped',
      summary: 'Application ID check waits for a valid bot token.',
    });
    checks.push({
      id: 'discord-guild',
      label: 'Discord server',
      status: 'skipped',
      summary: 'Server membership check waits for a valid bot token.',
    });
  } else {
    checks.push({
      id: 'discord-bot-token',
      label: 'Discord bot token',
      status: 'success',
      summary: tokenResult.meta?.botUsername
        ? `Bot token verified for ${tokenResult.meta.botUsername}.`
        : 'Discord bot token verified.',
    });
    Object.assign(meta, tokenResult.meta);

    // 2. Application ID (uses token)
    const appResult = await validateDiscordAppId(config.discordApplicationId, config.discordToken);
    if (!appResult.ok) {
      errors.push(appResult.error!);
      checks.push({
        id: 'discord-application',
        label: 'Discord application',
        status: 'failed',
        summary: 'Application ID does not match the bot token.',
        detail: appResult.error,
      });
    } else {
      checks.push({
        id: 'discord-application',
        label: 'Discord application',
        status: 'success',
        summary: 'Application ID matches the bot token.',
      });
    }

    // 4. Guild ID (optional, uses token)
    const guildResult = await validateGuildId(config.discordGuildId, config.discordToken);
    if (!guildResult.ok) {
      errors.push(guildResult.error!);
      checks.push({
        id: 'discord-guild',
        label: 'Discord server',
        status: 'failed',
        summary: 'Discord server membership could not be verified.',
        detail: guildResult.error,
      });
    } else {
      if (guildResult.meta) Object.assign(meta, guildResult.meta);
      checks.push({
        id: 'discord-guild',
        label: 'Discord server',
        status: 'success',
        summary: guildResult.meta?.guildName
          ? `Server readiness verified: ${guildResult.meta.guildName}.`
          : 'Discord server readiness verified.',
      });
    }
  }

  // 3. Client Secret — can't verify via API, just check it's not empty
  if (!config.discordClientSecret.trim()) {
    const error = 'Discord Client Secret is required. Get it from Discord Developer Portal → OAuth2 → Client Secret.';
    errors.push(error);
    checks.push({
      id: 'discord-client-secret',
      label: 'Discord client secret',
      status: 'failed',
      summary: 'Discord client secret is missing.',
      detail: error,
    });
  } else {
    checks.push({
      id: 'discord-client-secret',
      label: 'Discord client secret',
      status: 'success',
      summary: 'Discord client secret is filled in.',
      detail: 'Discord only proves this during OAuth redirects, so setup keeps it masked and passes it to the dashboard.',
    });
  }

  // 5. Supabase (independent of Discord)
  const supaResult = await validateSupabase(
    config.supabaseUrl,
    config.supabaseSecretKey,
    config.supabasePublishableKey,
  );
  if (!supaResult.ok) {
    errors.push(supaResult.error!);
    checks.push({
      id: 'supabase-project',
      label: 'Supabase project',
      status: 'failed',
      summary: 'Supabase project and API keys could not be verified.',
      detail: supaResult.error,
    });
  } else {
    checks.push({
      id: 'supabase-project',
      label: 'Supabase project',
      status: 'success',
      summary: 'Supabase project URL and API keys verified.',
    });
  }

  return { valid: errors.length === 0, errors, meta, checks };
}
