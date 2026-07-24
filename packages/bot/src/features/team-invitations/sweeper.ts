/**
 * Team-Invitation Sweeper — the bot-side lifecycle worker for consent-based
 * dashboard-team invitations (administration-team-management).
 *
 * The dashboard creates/accepts/revokes invitation rows (it cannot reach
 * Discord), so a bot-level periodic worker owns every Discord-facing effect and
 * the time-driven transition:
 *
 *   1. DM delivery   — for each freshly-queued pending invitation, DM the
 *      invitee with the role + accept path when invite-dm-enabled; on failure
 *      keep it pending (still acceptable via dashboard) and mirror the failure
 *      to the owner (team.invite_dm_failed).
 *   2. Accept mirror — mirror each acceptance to the owner exactly once.
 *   3. Expiry sweep  — transition pending invitations past their expiry to
 *      `expired` (granting nothing) and mirror to the owner (team.invite_expired).
 *
 * Every transition is claimed with a conditional UPDATE so a step is performed
 * at most once even across overlapping ticks, and audit rows are written
 * directly to audit_logs (the same self-contained pattern the rest of the bot
 * uses via services/audit).
 */
import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { writeAuditLog } from '../../services/audit.js';

const log = createLogger('TeamInviteSweep');

const BRAND_COLOR = 0xff1493;
const OWNER_COLOR = 0x5865f2;
const DEFAULT_INTERVAL_MS = 60_000;
const BATCH_LIMIT = 50;
const SWEEPER_ACTOR = 'team-invitation-sweeper';

interface InviteRow {
  id: string;
  guild_id: string;
  discord_id: string;
  role_id: string;
  invited_by: string | null;
  invited_by_name: string | null;
  expires_at: string;
  dashboard_roles: { name?: string | null } | { name?: string | null }[] | null;
}

const INVITE_SELECT =
  'id, guild_id, discord_id, role_id, invited_by, invited_by_name, expires_at, dashboard_roles(name)';

function roleNameOf(row: InviteRow): string {
  const dr = row.dashboard_roles;
  const one = Array.isArray(dr) ? dr[0] : dr;
  return one?.name ?? 'a dashboard role';
}

function hoursUntil(iso: string): number {
  return Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
}

export class TeamInvitationSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Client,
    private readonly supabase: SupabaseClient,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  /** Start the periodic sweep. Idempotent. Runs one pass immediately. */
  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    // Never keep the process alive solely for the sweep.
    (this.timer as { unref?: () => void }).unref?.();
    log.info('Team-invitation sweeper started', { intervalMs: this.intervalMs });
  }

  /** Stop the periodic sweep. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Team-invitation sweeper stopped');
    }
  }

  /** Run all three phases once. Each phase is isolated so one failure can't
   *  starve the others. */
  async runOnce(): Promise<void> {
    try {
      await this.deliverPendingDms();
    } catch (err) {
      log.error('DM-delivery phase failed', { error: String(err) });
    }
    try {
      await this.mirrorAcceptances();
    } catch (err) {
      log.error('Acceptance-mirror phase failed', { error: String(err) });
    }
    try {
      await this.expireOverdue();
    } catch (err) {
      log.error('Expiry-sweep phase failed', { error: String(err) });
    }
  }

  // ── Phase 1: DM delivery ──────────────────────────────────────────────────

  private async deliverPendingDms(): Promise<void> {
    const { data, error } = await this.supabase
      .from('team_invitations')
      .select(INVITE_SELECT)
      .eq('status', 'pending')
      .eq('dm_status', 'queued')
      .limit(BATCH_LIMIT);
    if (error) {
      log.error('Failed to read queued invitations', { error: error.message });
      return;
    }

    for (const row of (data ?? []) as InviteRow[]) {
      const guild = this.client.guilds.cache.get(row.guild_id);
      // Not in this process's cache (other shard / not ready) — retry next tick.
      if (!guild) continue;

      // Re-check invite-dm-enabled: the owner may have turned DMs off after the
      // invitation was queued.
      const { data: cfg } = await this.supabase
        .from('guild_config')
        .select('team_invite_dm_enabled')
        .eq('guild_id', row.guild_id)
        .maybeSingle();
      const dmEnabled = (cfg as { team_invite_dm_enabled?: boolean } | null)?.team_invite_dm_enabled ?? true;
      if (!dmEnabled) {
        await this.claimDm(row.id, 'skipped', 'dashboard');
        continue;
      }

      try {
        const user = await this.client.users.fetch(row.discord_id);
        await user.send({ embeds: [this.buildInviteEmbed(guild, row)] });
        await this.claimDm(row.id, 'sent', 'dm');
      } catch (err) {
        // Invitee's DMs are closed (or the user is unreachable). The invitation
        // STAYS pending and acceptable via dashboard sign-in — we only record
        // the delivery failure and mirror it to the owner (once).
        const claimed = await this.claimDm(row.id, 'failed', 'dashboard');
        if (!claimed) continue;
        await writeAuditLog(this.supabase, {
          guildId: row.guild_id,
          actorType: 'system',
          actorId: SWEEPER_ACTOR,
          action: 'team.invite_dm_failed',
          targetType: 'team_invitation',
          targetId: row.discord_id,
          details: { invitation_id: row.id, role_id: row.role_id },
          success: false,
          errorMessage: String(err),
        });
        await this.notifyOwner(guild, {
          color: OWNER_COLOR,
          title: 'Team invitation DM could not be delivered',
          description:
            `Could not DM <@${row.discord_id}> their **${roleNameOf(row)}** dashboard invitation ` +
            `(their DMs are closed). Share the invite link from the Team page instead — ` +
            `it stays valid until it expires.`,
        });
      }
    }
  }

  /** Atomically move a still-queued invitation's dm_status. Returns true only if
   *  THIS call performed the transition (so notifications fire exactly once). */
  private async claimDm(
    id: string,
    dmStatus: 'sent' | 'failed' | 'skipped',
    deliveryMode: 'dm' | 'dashboard',
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from('team_invitations')
      .update({ dm_status: dmStatus, delivery_mode: deliveryMode })
      .eq('id', id)
      .eq('dm_status', 'queued')
      .select('id')
      .maybeSingle();
    return !!data;
  }

  // ── Phase 2: acceptance mirror ────────────────────────────────────────────

  private async mirrorAcceptances(): Promise<void> {
    const { data, error } = await this.supabase
      .from('team_invitations')
      .select(INVITE_SELECT)
      .eq('status', 'accepted')
      .eq('accept_notified', false)
      .limit(BATCH_LIMIT);
    if (error) {
      log.error('Failed to read accepted invitations', { error: error.message });
      return;
    }

    for (const row of (data ?? []) as InviteRow[]) {
      const guild = this.client.guilds.cache.get(row.guild_id);
      // Wait for the guild to be cached before consuming the one-shot flag, so
      // the owner mirror is never silently dropped.
      if (!guild) continue;

      const { data: claimed } = await this.supabase
        .from('team_invitations')
        .update({ accept_notified: true })
        .eq('id', row.id)
        .eq('accept_notified', false)
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      await this.notifyOwner(guild, {
        color: BRAND_COLOR,
        title: 'Team invitation accepted',
        description:
          `<@${row.discord_id}> accepted the **${roleNameOf(row)}** invitation for **${guild.name}**. ` +
          `Welcome aboard!`,
      });
    }
  }

  // ── Phase 3: expiry sweep ─────────────────────────────────────────────────

  private async expireOverdue(): Promise<void> {
    const nowIso = new Date().toISOString();
    // Atomic across every guild: only rows still pending AND past expiry flip to
    // expired, and RETURNING gives us exactly the rows THIS pass transitioned.
    const { data, error } = await this.supabase
      .from('team_invitations')
      .update({ status: 'expired', responded_at: nowIso })
      .eq('status', 'pending')
      .lt('expires_at', nowIso)
      .select(INVITE_SELECT);
    if (error) {
      log.error('Failed to expire overdue invitations', { error: error.message });
      return;
    }

    for (const row of (data ?? []) as InviteRow[]) {
      await writeAuditLog(this.supabase, {
        guildId: row.guild_id,
        actorType: 'system',
        actorId: SWEEPER_ACTOR,
        action: 'team.invite_expired',
        targetType: 'team_invitation',
        targetId: row.discord_id,
        details: { invitation_id: row.id, role_id: row.role_id },
      });

      const guild = this.client.guilds.cache.get(row.guild_id);
      if (guild) {
        await this.notifyOwner(guild, {
          color: OWNER_COLOR,
          title: 'Team invitation expired',
          description:
            `The **${roleNameOf(row)}** invitation for <@${row.discord_id}> on **${guild.name}** ` +
            `expired without a response. You can send a fresh one anytime.`,
        });
      }
    }
  }

  // ── Discord helpers ───────────────────────────────────────────────────────

  private buildInviteEmbed(guild: Guild, row: InviteRow): EmbedBuilder {
    const roleName = roleNameOf(row);
    const hours = hoursUntil(row.expires_at);
    return new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(`You're invited to help run ${guild.name}`)
      .setDescription(
        `You've been invited to join the **${guild.name}** dashboard team as **${roleName}**.\n\n` +
          `Open the dashboard and accept within **${hours} hours** to gain access. ` +
          `You won't have any permissions until you accept.`,
      )
      .addFields(
        { name: 'Role', value: roleName, inline: true },
        { name: 'Expires in', value: `${hours}h`, inline: true },
      )
      .setFooter({ text: 'SomniBot • Team invitation' })
      .setTimestamp();
  }

  /**
   * Mirror a team-invitation event to the owner: post to the configured admin
   * channel (mod_log_channel_id) when set, and DM the guild owner. Best-effort —
   * a delivery failure never throws.
   */
  private async notifyOwner(
    guild: Guild,
    spec: { color: number; title: string; description: string },
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(spec.color)
      .setTitle(spec.title)
      .setDescription(spec.description)
      .setFooter({ text: 'SomniBot • Team' })
      .setTimestamp();

    const { data: cfg } = await this.supabase
      .from('guild_config')
      .select('mod_log_channel_id')
      .eq('guild_id', guild.id)
      .maybeSingle();
    const adminChannelId = (cfg as { mod_log_channel_id?: string | null } | null)?.mod_log_channel_id ?? null;

    if (adminChannelId) {
      try {
        const channel = guild.channels.cache.get(adminChannelId);
        if (channel && 'send' in channel) {
          await (channel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [embed] });
        }
      } catch (err) {
        log.error('Failed to post team event to admin channel', { error: String(err) });
      }
    }

    const ownerId = guild.ownerId;
    if (ownerId) {
      try {
        const owner = await this.client.users.fetch(ownerId);
        await owner.send({ embeds: [embed] });
      } catch (err) {
        log.error('Failed to DM owner team event', { error: String(err) });
      }
    }
  }
}

// ── Bot-level singleton (mirrors the anti-raid pruner pattern) ───────────────

let _sweeper: TeamInvitationSweeper | null = null;

/** Start the process-wide team-invitation sweeper. Idempotent. */
export function startTeamInvitationSweeper(
  client: Client,
  supabase: SupabaseClient,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): TeamInvitationSweeper {
  if (_sweeper) return _sweeper;
  _sweeper = new TeamInvitationSweeper(client, supabase, intervalMs);
  _sweeper.start();
  return _sweeper;
}

/** Stop the process-wide team-invitation sweeper. Idempotent. */
export function stopTeamInvitationSweeper(): void {
  if (_sweeper) {
    _sweeper.stop();
    _sweeper = null;
  }
}
