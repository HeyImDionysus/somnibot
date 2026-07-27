/**
 * Portal-Request Notifier — tells the buyer what the owner decided.
 *
 * The dashboard decides refund/support requests but cannot reach Discord, so
 * the DM has to happen here. Without this worker a decision was recorded and
 * the customer was never told — the queue moved, and from the buyer's side
 * nothing had happened.
 *
 * Two phases, deliberately separate so one failing cannot starve the other:
 *
 *   1. Delivery — DM each decided-but-undelivered request's buyer, claiming the
 *      `customer_notified` latch with a conditional UPDATE so overlapping ticks
 *      (or a restart mid-send) cannot DM the same decision twice.
 *   2. Ageing   — raise ONE throttled owner alert when requests have been left
 *      pending past the threshold, so a queue nobody is working does not stay
 *      invisible.
 *
 * ── Why the latch is claimed BEFORE the DM ────────────────────────────────
 * The alternative — DM first, then latch — double-DMs whenever the latch write
 * fails, which is the failure the latch exists to prevent. Claiming first means
 * a crash between claim and send loses ONE notification rather than sending
 * repeats forever; the request stays visible as decided, and the list still
 * shows it (it is no longer `awaitingDelivery`, so a failed send is reported to
 * the owner instead of retried blindly).
 */
import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { applyBrand, resolveBrandKit, type BrandIntent } from '../branding/index.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';

const log = createLogger('PortalRequestNotify');

const DEFAULT_INTERVAL_MS = 120_000;
const BATCH_LIMIT = 25;
/** Matches the dashboard list's `stale` flag so both agree on "left waiting". */
const STALE_AFTER_HOURS = 48;

interface DecidedRequest {
  id: string;
  guild_id: string;
  type: string;
  status: string;
  resolution_note: string | null;
  order_id: string | null;
  customers: { discord_id?: string | null } | { discord_id?: string | null }[] | null;
  orders: { order_number?: string | null } | { order_number?: string | null }[] | null;
}

const DECIDED_SELECT =
  'id, guild_id, type, status, resolution_note, order_id, '
  + 'customers(discord_id), orders(order_number)';

function firstOf<T>(value: T | T[] | null): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export class PortalRequestNotifier {
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
    // Never keep the process alive solely for this sweep.
    (this.timer as { unref?: () => void }).unref?.();
    log.info('Portal-request notifier started', { intervalMs: this.intervalMs });
  }

  /** Stop the periodic sweep. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Portal-request notifier stopped');
    }
  }

  async runOnce(): Promise<void> {
    try {
      await this.deliverDecisions();
    } catch (err) {
      log.error('Decision delivery pass failed', { error: String(err) });
    }
    try {
      await this.alertOnAgedRequests();
    } catch (err) {
      log.error('Aged-request pass failed', { error: String(err) });
    }
  }

  /** DM every decided request whose buyer has not been told yet. */
  private async deliverDecisions(): Promise<void> {
    const { data, error } = await this.supabase
      .from('commerce_portal_requests')
      .select(DECIDED_SELECT)
      .eq('customer_notified', false)
      .not('decided_at', 'is', null)
      .in('status', ['resolved', 'rejected'])
      .limit(BATCH_LIMIT);

    if (error) {
      log.error('Failed to read decided requests', { error: error.message });
      return;
    }

    for (const row of ((data ?? []) as unknown as DecidedRequest[])) {
      const guild = this.client.guilds.cache.get(row.guild_id);
      // Wait for the guild to be cached before consuming the one-shot latch, so
      // a decision is never marked delivered by a shard that cannot send it.
      if (!guild) continue;

      const discordId = firstOf(row.customers)?.discord_id;
      if (!discordId) {
        // No Discord identity to reach. Latch it so the owner sees it is not
        // pending delivery forever, and say so plainly.
        await this.claim(row.id);
        log.warn('Decided request has no Discord identity to notify', { requestId: row.id });
        continue;
      }

      // Claim FIRST: a failed latch write after a successful DM would re-send on
      // every tick, which is the exact failure this latch prevents.
      if (!(await this.claim(row.id))) continue;

      try {
        await this.sendDecisionDm(guild, row, discordId);
      } catch (err) {
        // The latch is already consumed, so surface this rather than retrying
        // blindly — the owner can re-send from the queue.
        log.warn('Could not DM decision to buyer', { requestId: row.id, error: String(err) });
        await raiseOwnerAlert(this.supabase, row.guild_id, {
          alertType: 'portal_request_dm_failed',
          severity: 'warning',
          title: 'Could not tell a customer your decision',
          message:
            `The decision on a ${row.type} request could not be delivered to <@${discordId}> `
            + '(their DMs are probably closed). They have not been told — reach out another way.',
          metadata: { request_id: row.id, request_type: row.type, discord_id: discordId },
          guild,
        }).catch(() => {});
      }
    }
  }

  /** Consume the one-shot latch. Returns true when THIS pass won it. */
  private async claim(requestId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('commerce_portal_requests')
      .update({ customer_notified: true })
      .eq('id', requestId)
      .eq('customer_notified', false)
      .select('id')
      .maybeSingle();
    return data != null;
  }

  private async sendDecisionDm(
    guild: Guild,
    row: DecidedRequest,
    discordId: string,
  ): Promise<void> {
    const kit = await resolveBrandKit(this.supabase, row.guild_id, { fallbackName: guild.name });
    const approved = row.status === 'resolved';
    const orderNumber = firstOf(row.orders)?.order_number;
    const label = row.type === 'refund' ? 'refund request' : 'support request';

    const embed = new EmbedBuilder()
      .setTitle(approved ? `✅ Your ${label} was approved` : `❌ Your ${label} was declined`)
      .setDescription(
        `**${kit.brandName}** has reviewed your ${label}`
        + (orderNumber ? ` for order **${orderNumber}**` : '')
        + '.',
      )
      .setTimestamp();

    if (row.resolution_note) {
      embed.addFields({ name: 'What they said', value: row.resolution_note.slice(0, 1024) });
    }

    // An approved refund request is a DECISION, not a completed payment — the
    // money moves through the seller's refund action. Saying "you have been
    // refunded" here would be a lie the buyer acts on.
    if (approved && row.type === 'refund') {
      embed.addFields({
        name: 'What happens next',
        value: 'The refund is being processed separately — it can take a few days to appear.',
      });
    }

    const intent: BrandIntent = approved ? 'primary' : 'warning';
    applyBrand(embed, kit, { intent });

    const user = await this.client.users.fetch(discordId);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });

    log.info('Delivered portal-request decision', { requestId: row.id, status: row.status });
  }

  /**
   * One throttled alert per guild when requests have been left pending.
   *
   * raiseOwnerAlert dedupes on an unresolved alert of the same type, so this
   * nags once rather than every two minutes.
   */
  private async alertOnAgedRequests(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3_600_000).toISOString();

    const { data, error } = await this.supabase
      .from('commerce_portal_requests')
      .select('guild_id')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .limit(500);

    if (error || !data) return;

    const perGuild = new Map<string, number>();
    for (const row of data as Array<{ guild_id: string }>) {
      perGuild.set(row.guild_id, (perGuild.get(row.guild_id) ?? 0) + 1);
    }

    for (const [guildId, count] of perGuild) {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) continue;
      await raiseOwnerAlert(this.supabase, guildId, {
        alertType: 'portal_request_pending',
        severity: 'warning',
        title: `${count} customer request${count === 1 ? '' : 's'} waiting for you`,
        message:
          `${count} refund/support request${count === 1 ? ' has' : 's have'} been waiting more than `
          + `${STALE_AFTER_HOURS} hours with no decision. Customers cannot be told anything until `
          + 'you review them on the Store → Requests page.',
        metadata: { pending_count: count, threshold_hours: STALE_AFTER_HOURS },
        guild,
      }).catch(() => {});
    }
  }
}

/** Construct and start the notifier. */
export function startPortalRequestNotifier(
  client: Client,
  supabase: SupabaseClient,
  intervalMs?: number,
): PortalRequestNotifier {
  const notifier = new PortalRequestNotifier(client, supabase, intervalMs);
  notifier.start();
  return notifier;
}
