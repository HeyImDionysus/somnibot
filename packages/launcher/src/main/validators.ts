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

export async function validateSupabase(
  url: string,
  secretKey: string,
  publishableKey: string,
): Promise<ValidationResult> {
  if (!url.trim()) return { ok: false, error: 'Supabase URL is required.' };
  if (!secretKey.trim()) return { ok: false, error: 'Supabase Secret Key is required.' };
  if (!publishableKey.trim()) return { ok: false, error: 'Supabase Publishable Key is required.' };

  // Validate URL format
  try {
    new URL(url.trim());
  } catch {
    return { ok: false, error: 'Invalid Supabase URL. Expected something like "https://your-project.supabase.co".' };
  }

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
      return { ok: false, error: 'Supabase Secret Key is invalid. Get it from Supabase → Settings → API → Secret Key (sb_secret_...).' };
    }
    // 200 means REST endpoint is reachable — good enough
  } catch (err) {
    return { ok: false, error: `Could not reach Supabase at ${url.trim()}. Check the URL and your internet connection.\n${String(err)}` };
  }

  // Verify publishable key
  try {
    const res = await fetch(`${url.trim()}/rest/v1/`, {
      headers: {
        apikey: publishableKey.trim(),
        Authorization: `Bearer ${publishableKey.trim()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Supabase Publishable Key is invalid. Get it from Supabase → Settings → API → Publishable Key (sb_publishable_...).' };
    }
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

  // 1. Discord token (must come first — other Discord checks need it)
  const tokenResult = await validateDiscordToken(config.discordToken);
  if (!tokenResult.ok) {
    errors.push(tokenResult.error!);
    // Can't continue Discord validation without a valid token
    return { valid: false, errors, meta };
  }
  Object.assign(meta, tokenResult.meta);

  // 2. Application ID (uses token)
  const appResult = await validateDiscordAppId(config.discordApplicationId, config.discordToken);
  if (!appResult.ok) errors.push(appResult.error!);

  // 3. Client Secret — can't verify via API, just check it's not empty
  if (!config.discordClientSecret.trim()) {
    errors.push('Discord Client Secret is required. Get it from Discord Developer Portal → OAuth2 → Client Secret.');
  }

  // 4. Guild ID (optional, uses token)
  const guildResult = await validateGuildId(config.discordGuildId, config.discordToken);
  if (!guildResult.ok) errors.push(guildResult.error!);
  else if (guildResult.meta) Object.assign(meta, guildResult.meta);

  // 5. Supabase (independent of Discord)
  const supaResult = await validateSupabase(
    config.supabaseUrl,
    config.supabaseSecretKey,
    config.supabasePublishableKey,
  );
  if (!supaResult.ok) errors.push(supaResult.error!);

  return { valid: errors.length === 0, errors, meta };
}
