/**
 * HeistManager — multi-user cooperative heist system.
 *
 * Flow: /heist start → recruiting phase (join window) → resolve (success/fail) → payouts.
 * Participants join with /heist join. Each additional member increases success chance.
 * Roles are randomly assigned: Hacker, Muscle, Lookout, Driver, Demolitions.
 */
import { randomPick } from '../../utils/random.js';
import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import type Valkey from 'iovalkey';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { eventBus } from '../../services/event-bus.js';
import { resolveBrandKit, brandKitFromConfig } from '../branding/brand-kit.js';
import { applyBrand, brandedEmbed } from '../branding/branded-embed.js';

const log = createLogger('Heist');

// ── Module-level state ────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, HeistManager>();

export function registerHeistManager(mgr: HeistManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterHeistManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateHeistCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}
export function getHeistManager(guildId?: string): HeistManager | null {
  if (guildId) return _managers.get(guildId) ?? null;
  return _managers.values().next().value ?? null;
}

// ── Constants ─────────────────────────────────────────────

const HEIST_ROLES = ['Hacker', 'Muscle', 'Lookout', 'Driver', 'Demolitions'] as const;

const HEIST_TARGETS = [
  { name: 'Corner Store', difficultyMod: 0, payoutMod: 0.5 },
  { name: 'City Bank', difficultyMod: 0, payoutMod: 1.0 },
  { name: 'The Museum', difficultyMod: -5, payoutMod: 1.5 },
  { name: 'Federal Reserve', difficultyMod: -10, payoutMod: 2.0 },
  { name: 'The Vault of Legends', difficultyMod: -15, payoutMod: 3.0 },
];

const SUCCESS_STORIES = [
  'The crew slipped past every guard and cracked the vault wide open!',
  'A masterful execution — in and out before anyone noticed!',
  'Alarms blared but the team moved like clockwork. Clean getaway!',
  'The hacker killed the cameras just in time. Perfect heist!',
  'Against all odds, the crew pulled it off!',
];

const FAIL_STORIES = [
  'The alarm triggered and the crew scattered. Everyone got caught!',
  'A guard spotted the lookout — the whole plan fell apart.',
  'The vault had a secondary lock nobody expected. Busted!',
  'Someone tripped a laser grid. The cops were there in seconds.',
  'The getaway car wouldn\'t start. Classic.',
];

// ── Manager ───────────────────────────────────────────────

export class HeistManager {
  private supabase: SupabaseClient;
  private client: Client;
  private valkey: Valkey | null;
  private configCache = new Map<string, DbGuildConfig>();
  private resolveTimers = new Map<string, NodeJS.Timeout>();
  // In-process retry timers for heists left 'in_progress' by a transient payout
  // /finalise error. Without these, a stranded heist would only be retried by
  // resumePendingHeists on the NEXT bot restart, while /heist start treats
  // 'in_progress' as an active heist — a transient DB blip would otherwise block
  // the guild from running heists until a manual restart.
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private retryAttempts = new Map<string, number>();

  constructor(supabase: SupabaseClient, client: Client, valkey?: Valkey) {
    this.supabase = supabase;
    this.client = client;
    this.valkey = valkey ?? null;
  }

  clearCache(): void { this.configCache.clear(); }

  cleanup(): void {
    for (const timer of this.resolveTimers.values()) clearTimeout(timer);
    this.resolveTimers.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  // Bounded in-process retry for a heist stranded 'in_progress' by a transient
  // payout/finalise error. resolveHeist is fully idempotent (paid_at guard on
  // credits, single-shot finalise), so a retry only settles the still-unpaid
  // crew and announces at most once. Exponential backoff, capped attempts; once
  // exhausted the heist is left for resumePendingHeists on the next restart (it
  // is never lost — the frozen decision persists on the row).
  private static readonly MAX_RETRY_ATTEMPTS = 5;
  private scheduleResolveRetry(guildId: string, heistId: string, channelId: string): void {
    // A resolve timer already owns this heist (e.g. re-scheduled elsewhere) —
    // don't stack a second one.
    if (this.retryTimers.has(heistId)) return;
    const attempt = (this.retryAttempts.get(heistId) ?? 0) + 1;
    if (attempt > HeistManager.MAX_RETRY_ATTEMPTS) {
      log.error(`Heist ${heistId} still in_progress after ${HeistManager.MAX_RETRY_ATTEMPTS} in-process retries — leaving for next restart's resume`);
      this.retryAttempts.delete(heistId);
      // [game-economy-heist] Settlement/retry exhausted — raise an owner alert
      // (catalog ownerNotification:true) and an append-only audit event so a
      // stranded heist that could not settle is operator-visible.
      void this.raiseSettlementFailedAlert(guildId, heistId);
      eventBus.emit('heist.settlement_failed', guildId, {
        heistId,
        attempts: HeistManager.MAX_RETRY_ATTEMPTS,
      });
      return;
    }
    this.retryAttempts.set(heistId, attempt);
    const delayMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1)); // 1s,2s,4s,8s,16s (cap 30s)
    const timer = setTimeout(async () => {
      this.retryTimers.delete(heistId);
      try {
        await this.resolveHeist(guildId, heistId, channelId);
      } catch (err) {
        log.error(`In-process retry for heist ${heistId} threw:`, err);
      }
    }, delayMs);
    // Do not keep the event loop alive solely for a retry.
    if (typeof timer.unref === 'function') timer.unref();
    this.retryTimers.set(heistId, timer);
  }

  /**
   * [game-economy-heist] Raise a settlement-failed owner alert when a heist could
   * not be settled after all in-process retries were exhausted, so the stranded
   * heist (left for the next restart's resume) is operator-visible. Best effort —
   * a failed alert never blocks or throws in the retry path.
   */
  private async raiseSettlementFailedAlert(guildId: string, heistId: string): Promise<void> {
    try {
      await raiseOwnerAlert(this.supabase, guildId, {
        alertType: 'heist_settlement_failed',
        severity: 'critical',
        title: 'Heist settlement failed',
        message: `Heist ${heistId} could not be settled after ${HeistManager.MAX_RETRY_ATTEMPTS} retries. It is left in_progress for the next restart's resume.`,
        metadata: { heist_id: heistId, attempts: HeistManager.MAX_RETRY_ATTEMPTS },
        client: this.client,
      });
    } catch (err) {
      log.warn('heist settlement-failed alert failed:', (err as Error)?.message ?? err);
    }
  }

  /** Cancel any pending in-process retry and drop its attempt counter. */
  private clearRetryState(heistId: string): void {
    const timer = this.retryTimers.get(heistId);
    if (timer) { clearTimeout(timer); this.retryTimers.delete(heistId); }
    this.retryAttempts.delete(heistId);
  }

  /**
   * Read the guild config (cached). `degraded` is true only when the read FAILED
   * (e.g. a database outage) as opposed to genuinely finding no row (PGRST116) —
   * callers must not present a failed read as "heists are not enabled", which is
   * a data-shaped lie about config state the bot could not read.
   */
  private async getConfig(
    guildId: string,
  ): Promise<{ config: DbGuildConfig | null; degraded: boolean }> {
    const cached = this.configCache.get(guildId);
    if (cached) return { config: cached, degraded: false };
    const { data, error } = await this.supabase
      .from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return { config: data, degraded: error != null && error.code !== 'PGRST116' };
  }

  /**
   * Branded degradation notice for a dependency outage. A failed READ must never
   * degrade into a data-shaped answer ("no heists yet", "you need N coins") —
   * that is a lie about state the bot could not read. The brand lookup is itself
   * outage-safe: resolveBrandKit never throws (belt-and-braces .catch) and the
   * guild name is the fallback, so this reply renders during a full DB outage.
   */
  private async replyHeistUnavailable(
    interaction: ChatInputCommandInteraction,
    suffix = '',
  ): Promise<void> {
    const brandKit = await resolveBrandKit(this.supabase, interaction.guildId!, {
      fallbackName: interaction.guild?.name,
    }).catch(() => null);
    const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
    const content = `⚠️ ${name}'s heists are temporarily unavailable — please try again in a moment.${suffix}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * Resolve the guild's white-label currency display. Every member-facing heist
   * embed brands with these instead of the literal word "coins", mirroring the
   * rest of the economy (economy/commands.ts). Columns are NOT NULL, so the
   * fallbacks only guard a null/partial config.
   */
  private currencyOf(config: DbGuildConfig | null): { cName: string; cEmoji: string } {
    return { cName: config?.currency_name ?? 'Coins', cEmoji: config?.currency_emoji ?? '🪙' };
  }

  async startHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const { config, degraded } = await this.getConfig(guildId);

    // A failed config read is an outage, not "heists are off" — degrade honestly.
    if (degraded) {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }
    if (!config?.economy_heist_enabled) {
      await interaction.reply({ content: '🚫 Heists are not enabled on this server.', ephemeral: true });
      return;
    }
    const { cName, cEmoji } = this.currencyOf(config);
    const kit = brandKitFromConfig(config, interaction.guild?.name);

    // V53-L3: Valkey-based atomic cooldown (defense-in-depth alongside DB check + unique index)
    const cooldownSecs = config.economy_heist_cooldown_seconds ?? 300;
    if (this.valkey && cooldownSecs > 0) {
      const cooldownKey = `heist:cd:${guildId}`;
      const locked = await this.valkey.set(cooldownKey, '1', 'EX', cooldownSecs, 'NX');
      if (!locked) {
        const ttl = await this.valkey.ttl(cooldownKey);
        const remaining = Math.ceil(ttl / 60);
        await interaction.reply({
          content: `⏰ The crew needs to lay low. Next heist available in **${remaining}m**.`,
          ephemeral: true,
        });
        return;
      }
    }

    // Check cooldown (DB fallback — covers case where Valkey was unavailable at last resolve)
    const { data: recent, error: recentErr } = await this.supabase
      .from('economy_heists')
      .select('resolved_at')
      .eq('guild_id', guildId)
      .in('status', ['success', 'failed'])
      .order('resolved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // A failed cooldown read means the database is unreachable — do NOT press on
    // toward a wallet debit against a dependency we already know is down.
    if (recentErr) {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }

    if (recent?.resolved_at) {
      const cooldownMs = cooldownSecs * 1000;
      const elapsed = Date.now() - new Date(recent.resolved_at).getTime();
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        await interaction.reply({
          content: `⏰ The crew needs to lay low. Next heist available in **${remaining}m**.`,
          ephemeral: true,
        });
        return;
      }
    }

    // Check no active heist
    const { data: active, error: activeErr } = await this.supabase
      .from('economy_heists')
      .select('id')
      .eq('guild_id', guildId)
      .in('status', ['recruiting', 'in_progress'])
      .limit(1)
      .maybeSingle();

    // Same honesty rule: an unreadable active-heist state is an outage, never
    // "no active heist" (pressing on could debit against a down database).
    if (activeErr) {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }

    if (active) {
      await interaction.reply({
        content: '❌ There\'s already an active heist! Use `/heist join` to join it.',
        ephemeral: true,
      });
      return;
    }

    // Check balance for entry fee
    const entryFee = config.economy_heist_entry_fee ?? 100;
    const { data: wallet, error: walletErr } = entryFee > 0
      ? await this.supabase
          .from('economy_wallets').select('wallet')
          .eq('guild_id', guildId).eq('user_id', userId).single()
      : { data: { wallet: 0 }, error: null };

    // A FAILED wallet read is not an empty wallet: telling the member they "need
    // N coins" off a read the bot could not perform is a fabricated balance.
    // PGRST116 (no row) is a genuine no-wallet case and falls through below.
    if (walletErr && walletErr.code !== 'PGRST116') {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }

    if (!wallet || wallet.wallet < entryFee) {
      await interaction.reply({
        content: `❌ You need ${cEmoji} **${entryFee.toLocaleString()}** ${cName} to start a heist.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct entry fee (atomic — raises on insufficient balance)
    const { error: feeErr } = entryFee > 0
      ? await this.supabase.rpc('economy_subtract_balance', {
          p_guild_id: guildId, p_user_id: userId, p_amount: entryFee,
        })
      : { error: null };
    if (feeErr) {
      // Only a genuine insufficient-balance raise may claim the member lacks
      // coins; a network/transient RPC failure debited nothing and must degrade
      // honestly rather than fabricate a balance verdict.
      if (/insufficient/i.test(feeErr.message ?? '')) {
        await interaction.reply({ content: `❌ Payment failed — you need ${cEmoji} **${entryFee.toLocaleString()}** ${cName}.`, ephemeral: true });
      } else {
        await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      }
      return;
    }

    // Pick random target
    const target = randomPick(HEIST_TARGETS);
    const basePayout = Math.floor((config.economy_heist_base_payout ?? 500) * target.payoutMod);
    const joinWindowSecs = config.economy_heist_join_window_secs ?? 60;
    const expiresAt = new Date(Date.now() + joinWindowSecs * 1000).toISOString();

    // The immutable single-member (base) chance: base success pct + this target's
    // difficulty modifier. This is the ONLY chance value stored on the heist row
    // (as base_success_chance) — success_chance is no longer stored; it is DERIVED
    // everywhere from base_success_chance + the participant-row count, so there is
    // no mutable counter to drift. For a 1-member crew the derived chance equals
    // this base (LEAST(95, GREATEST(0, base + 0)) with base in 25..40).
    const baseChance = (config.economy_heist_success_base_pct ?? 40) + target.difficultyMod;

    // V48-M2 / row-derived-crew: create the heist AND the initiator participant row
    // ATOMICALLY. Crew membership is now DERIVED from economy_heist_participants
    // rows, so the initiator's row MUST exist the moment the heist becomes
    // derivable — a two-statement "insert heist, then insert initiator" left a gap
    // where a concurrent /heist join saw the recruiting heist with ZERO crew rows,
    // could fill it to max, and then the initiator insert would exceed max / derive
    // the wrong count. heist_start does both inserts in ONE transaction. The partial
    // unique index `uniq_active_heist_per_guild` still guards the racy "no active
    // heist" check above: if another /heist start already committed an active heist,
    // heist_start raises 23505, rolls the whole tx back (nothing half-inserted), and
    // returns 'duplicate_active'. We refund the pre-debited entry fee on any failure
    // so the loser isn't charged for a heist they didn't get to start.
    const role = randomPick(HEIST_ROLES);
    const { data: startData, error: startErr } = await this.supabase.rpc('heist_start', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_target_name: target.name,
      p_target_payout: basePayout,
      // Single source of truth for the chance: the immutable base anchor. Crew
      // membership lives ONLY in economy_heist_participants rows (the initiator row
      // is inserted in the SAME tx) — there is no denormalized participants[] array.
      p_base_chance: baseChance,
      p_expires_at: expiresAt,
      p_role: role,
      // Freeze the exact fee this member paid on the row. Keeps entry_fee_paid
      // uniformly populated so no reconcile falls back to mutable config.
      p_entry_fee: entryFee,
    });

    const startResult = (Array.isArray(startData) ? startData[0] : startData) as
      | { status: string; heist_id: string | null }
      | null;
    const heistId = startResult?.heist_id ?? null;

    if (startErr || !startResult || startResult.status !== 'started' || !heistId) {
      const duplicate = startResult?.status === 'duplicate_active';
      // Refund only when a fee was charged. The positive-only balance RPC
      // rejects zero; a free heist therefore has nothing to compensate.
      const { error: refundErr } = entryFee > 0
        ? await this.supabase.rpc('economy_refund_balance', {
            p_guild_id: guildId, p_user_id: userId, p_amount: entryFee,
            p_idempotency_key: `heist:start-refund:${interaction.id}`,
          })
        : { error: null };
      if (refundErr) {
        log.error('CRITICAL: heist_start failed AND refund failed', {
          guildId, userId, entryFee, startErr, refundErr,
        });
        const alertResult = await raiseOwnerAlert(this.supabase, guildId, {
          alertType: 'heist_entry_fee_refund_failed',
          severity: 'critical',
          title: 'Heist entry-fee refund failed',
          message: `A failed heist start left an unconfirmed refund of ${entryFee} coins for member ${userId}.`,
          metadata: { user_id: userId, amount: entryFee, interaction_id: interaction.id },
          client: this.client,
        }).catch((alertErr: unknown) => {
          log.error('CRITICAL: heist refund owner alert failed', {
            guildId,
            userId,
            error: alertErr instanceof Error ? alertErr.message : String(alertErr),
          });
          return { inserted: false, delivered: false, insertErrorCode: undefined };
        });
        const ownerSignalled =
          alertResult.inserted ||
          alertResult.delivered ||
          alertResult.insertErrorCode === '23505';
        await this.replyHeistUnavailable(
          interaction,
          ownerSignalled
            ? ' Your entry fee refund could not be confirmed — an administrator was notified.'
            : ' Your entry fee refund and the administrator notification could not be confirmed. Please contact an administrator.',
        );
        return;
      }
      const refundSuffix = entryFee > 0 ? ' Your entry fee was refunded.' : ' Nothing was charged.';
      if (duplicate) {
        await interaction.reply({
          content: `❌ Someone else just started a heist! Use \`/heist join\` to join it.${refundSuffix}`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `❌ Failed to create heist.${refundSuffix}`,
          ephemeral: true,
        });
      }
      return;
    }

    // [game-economy-heist] Append-only audit row for the heist start state change
    // (initiator charged, crew recruiting).
    eventBus.emit('heist.started', guildId, {
      heistId,
      userId,
      targetName: target.name,
      basePayout,
      entryFee,
    });

    // Schedule resolution
    const timer = setTimeout(async () => {
      try {
        await this.resolveHeist(guildId, heistId, interaction.channelId);
      } catch (err) {
        log.error(`Failed to resolve heist ${heistId} in guild ${guildId}:`, err);
      }
    }, joinWindowSecs * 1000);
    this.resolveTimers.set(heistId, timer);

    const maxParticipants = config.economy_heist_max_participants ?? 8;

    await interaction.reply({
      embeds: [applyBrand(
        new EmbedBuilder()
          .setTitle(`🏴‍☠️ Heist: ${target.name}`)
          .setDescription(
            `<@${userId}> is assembling a crew to rob **${target.name}**!\n\n` +
            `💰 Potential payout: ${cEmoji} **${basePayout.toLocaleString()}** ${cName} (split among crew)\n` +
            `🎯 Base success chance: **${baseChance}%** (+7% per extra member)\n` +
            `💵 Entry fee: ${cEmoji} **${entryFee.toLocaleString()}** ${cName}\n` +
            `👥 Crew: 1/${maxParticipants}\n\n` +
            `Use \`/heist join\` within **${joinWindowSecs}s** to join the crew!`
          )
          .setFooter({ text: `Heist resolves in ${joinWindowSecs} seconds` }),
        kit,
        { intent: 'warning' },
      )],
    });
  }

  async joinHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const { config, degraded } = await this.getConfig(guildId);

    // A failed config read is an outage, not "heists are off" — degrade honestly.
    if (degraded) {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }
    if (!config?.economy_heist_enabled) {
      await interaction.reply({ content: '🚫 Heists are not enabled.', ephemeral: true });
      return;
    }
    const { cName, cEmoji } = this.currencyOf(config);
    const kit = brandKitFromConfig(config, interaction.guild?.name);

    // Find the active recruiting heist for display context (target name / max).
    // This read is NOT a guard — the atomic heist_join RPC below re-checks the
    // status under the heist-row lock and is the sole authority on whether the
    // join is admitted. We only use this row for the target's difficulty modifier
    // (to derive the base success chance) and for a fast "no heist" UX reply.
    const { data: heist, error: heistErr } = await this.supabase
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .eq('status', 'recruiting')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // A failed read is NOT "no heist recruiting" — that answer is fabricated
    // from state the bot could not read. Degrade honestly instead.
    if (heistErr) {
      await this.replyHeistUnavailable(interaction, ' Nothing was charged.');
      return;
    }

    if (!heist) {
      await interaction.reply({
        content: '❌ No heist is currently recruiting. Use `/heist start` to begin one!',
        ephemeral: true,
      });
      return;
    }

    const max = config.economy_heist_max_participants ?? 8;
    const entryFee = config.economy_heist_entry_fee ?? 100;
    const role = randomPick(HEIST_ROLES);
    // The single-member (base) chance: base success pct + this target's difficulty
    // modifier. heist_join DERIVES the returned success_chance from the post-join
    // participant-ROW count anchored on this value; nothing is stored, so there is
    // no counter to drift (and an undo simply reads one fewer row). This is the
    // same value persisted as base_success_chance at start — recomputed here from
    // config+target because the join-read heist row no longer carries a chance
    // counter (only base_success_chance, which equals this).
    const baseChance = (config.economy_heist_success_base_pct ?? 40)
      + (HEIST_TARGETS.find(t => t.name === heist.target_name)?.difficultyMod ?? 0);

    // ── Atomic, serialized join ───────────────────────────────
    // heist_join does the ENTIRE join — re-check status='recruiting', debit the
    // fee, insert the participant row (with the frozen entry_fee_paid), and derive
    // success_chance from the participant-row count — in ONE transaction under the
    // SAME heist-row lock heist_claim_for_resolution takes. No participants[] array
    // is written; the row IS the membership. This SERIALIZES the
    // join against resolution: if the claim wins the lock first, this call sees
    // status <> 'recruiting' and returns 'not_recruiting' having debited NOTHING,
    // so no fee can ever be stranded past the recruiting → resolution edge (codex
    // heist-manager.ts:797). A post-recruiting insert is structurally impossible,
    // so the old settle/undo/reconcile dance is gone from the happy path.
    const { data: joinData, error: joinErr } = await this.supabase.rpc('heist_join', {
      p_heist_id: heist.id,
      p_user_id: userId,
      p_role: role,
      p_entry_fee: entryFee,
      p_max: max,
      p_base_chance: baseChance,
    });
    if (joinErr) {
      // The RPC transaction rolled back — nothing was debited or inserted (debit
      // and insert commit together or not at all). Surface a clean failure without
      // claiming any charge or refund; the user can simply retry.
      log.error(`heist_join failed for heist ${heist.id}, user ${userId}:`, joinErr.message);
      await interaction.reply({
        content: `❌ Something went wrong joining the heist. No ${cName} were charged — please try \`/heist join\` again.`,
        ephemeral: true,
      });
      return;
    }

    const result = (Array.isArray(joinData) ? joinData[0] : joinData) as
      | { status: string; member_count: number; success_chance: number; role: string | null }
      | null;
    const joinStatus = result?.status ?? 'no_heist';

    if (joinStatus === 'not_recruiting' || joinStatus === 'no_heist') {
      // The claim won the row lock first (or the heist is gone). Nothing was
      // charged — no refund to confirm, no stranded fee, no "Joined" embed.
      await interaction.reply({
        content: `❌ The heist already got underway before you could join. No ${cName} were charged.`,
        ephemeral: true,
      });
      return;
    }
    if (joinStatus === 'already_joined') {
      await interaction.reply({ content: '❌ You\'re already in this heist!', ephemeral: true });
      return;
    }
    if (joinStatus === 'crew_full') {
      await interaction.reply({ content: '❌ The crew is full!', ephemeral: true });
      return;
    }
    if (joinStatus === 'insufficient_funds') {
      await interaction.reply({
        content: `❌ You need ${cEmoji} **${entryFee.toLocaleString()}** ${cName} to join.`,
        ephemeral: true,
      });
      return;
    }
    if (joinStatus !== 'joined') {
      log.error(`heist_join returned unexpected status "${joinStatus}"`, {
        guildId,
        heistId: heist.id,
        userId,
      });
      await this.replyHeistUnavailable(interaction, ` No ${cName} were charged.`);
      return;
    }

    // joinStatus === 'joined' — the member is atomically in the frozen-or-recruiting
    // crew with the fee debited and the row inserted, all in one commit. Crew size
    // and chance come straight from the RPC result (both DERIVED from the
    // participant rows under the heist-row lock); there is no participants[] array
    // to fall back on. The ?? guards only cover a malformed result shape.
    const actualCount = result?.member_count ?? 1;
    const displayChance = result?.success_chance
      ?? Math.max(0, Math.min(95, baseChance + (actualCount - 1) * 7));
    const joinedRole = result?.role ?? role;

    // [game-economy-heist] Append-only audit row for the join state change
    // (member charged the entry fee and added to the crew).
    eventBus.emit('heist.joined', guildId, {
      heistId: heist.id,
      userId,
      memberCount: actualCount,
      role: joinedRole,
    });

    getQuestsManager(guildId)?.trackProgress(guildId, userId, 'heist').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'warning',
        title: '🏴‍☠️ Joined the Heist!',
        description:
          `<@${userId}> joined as the **${joinedRole}**!\n\n` +
          `👥 Crew: **${actualCount}/${max}**\n` +
          `🎯 Success chance: **${displayChance}%**`,
      })],
    });
  }

  /**
   * Crew of a heist, derived from the participant ROWS (the single source of
   * truth), as Discord mentions in stable join order. Used for display only.
   * A failed read yields an empty list — /heist view is a read-only status
   * command, so a transient blip degrades to an empty crew line rather than
   * throwing; it never drives money.
   */
  private async crewMentions(heistId: string): Promise<string[]> {
    const { data } = await this.supabase
      .from('economy_heist_participants')
      .select('user_id')
      .eq('heist_id', heistId)
      .order('joined_at', { ascending: true })
      .limit(1000);
    return ((data ?? []) as Array<{ user_id: string }>).map((r) => `<@${r.user_id}>`);
  }

  async viewHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const { config } = await this.getConfig(guildId);
    const { cName, cEmoji } = this.currencyOf(config);
    const kit = brandKitFromConfig(config, interaction.guild?.name);

    const { data: heist, error: heistErr } = await this.supabase
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .in('status', ['recruiting', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // A failed READ is not "no heists yet": answering the empty-state line off a
    // read the bot could not perform is a data-shaped lie. Degrade honestly.
    if (heistErr) {
      await this.replyHeistUnavailable(interaction);
      return;
    }

    if (!heist) {
      // Show last completed heist
      const { data: last, error: lastErr } = await this.supabase
        .from('economy_heists')
        .select('*')
        .eq('guild_id', guildId)
        .in('status', ['success', 'failed'])
        .order('resolved_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastErr) {
        await this.replyHeistUnavailable(interaction);
        return;
      }

      if (!last) {
        await interaction.reply({
          embeds: [brandedEmbed(kit, {
            intent: 'info',
            title: '🏴‍☠️ Heist Status',
            description: 'No heists have been attempted yet! Use `/heist start` to begin one.',
          })],
        });
        return;
      }

      // Crew is derived from the participant rows — the single source of truth
      // (there is no participants[] array on the heist row anymore).
      const lastCrew = await this.crewMentions(last.id);
      const resultEmoji = last.status === 'success' ? '✅' : '❌';
      await interaction.reply({
        embeds: [brandedEmbed(kit, {
          intent: last.status === 'success' ? 'primary' : 'danger',
          title: `🏴‍☠️ Last Heist: ${last.target_name}`,
          description:
            `${resultEmoji} **${last.status === 'success' ? 'SUCCESS' : 'FAILED'}**\n\n` +
            `👥 Crew: ${lastCrew.join(', ')}\n` +
            `💰 Payout: ${cEmoji} **${last.target_payout.toLocaleString()}** ${cName}\n` +
            `📅 ${new Date(last.resolved_at).toLocaleString()}`,
        })],
      });
      return;
    }

    // Derive the active crew from the participant rows, then derive the current
    // success chance from base_success_chance + the crew size (never a stored
    // counter): LEAST(95, GREATEST(0, base + (count - 1) * 7)).
    const crewMentions = await this.crewMentions(heist.id);
    const crewSize = crewMentions.length;
    const participants = crewMentions.join(', ');
    const displayChance = Math.max(
      0, Math.min(95, (heist.base_success_chance ?? 0) + (crewSize - 1) * 7));
    const remainingSecs = Math.max(0, Math.floor((new Date(heist.expires_at).getTime() - Date.now()) / 1000));

    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'warning',
        title: `🏴‍☠️ Active Heist: ${heist.target_name}`,
        description:
          `Status: **${heist.status}**\n\n` +
          `👥 Crew: ${participants}\n` +
          `🎯 Success chance: **${displayChance}%**\n` +
          `💰 Potential payout: ${cEmoji} **${heist.target_payout.toLocaleString()}** ${cName}\n` +
          `⏱️ ${remainingSecs > 0 ? `Resolves in **${remainingSecs}s**` : 'Resolving...'}`,
      })],
    });
  }

  private async resolveHeist(guildId: string, heistId: string, channelId: string): Promise<void> {
    this.resolveTimers.delete(heistId);

    const { config } = await this.getConfig(guildId);
    const minParticipants = config?.economy_heist_min_participants ?? 2;
    const entryFee = config?.economy_heist_entry_fee ?? 100;
    const { cName, cEmoji } = this.currencyOf(config);
    const kit = brandKitFromConfig(config, this.client?.guilds?.cache?.get(guildId)?.name);

    // Read the row for the display fields (target, chance). Not a guard —
    // the atomic claim below is the sole authority on whether we resolve.
    const { data: heist } = await this.supabase
      .from('economy_heists')
      .select('*')
      .eq('id', heistId)
      .single();
    if (!heist) return;

    // ── Atomic, single-shot claim ─────────────────────────────
    // Flips recruiting→in_progress (with the outcome + payout frozen on the
    // row) or recruiting→cancelled, under FOR UPDATE. Only ONE caller — the
    // one that observes 'recruiting' — gets claimed=true. A concurrent timer,
    // a resume after crash, or a duplicate resume all get claimed=false and
    // must not re-decide or re-pay. If the heist was already claimed
    // (status='in_progress') by a crash before finalisation, we skip the
    // claim and fall through to the idempotent settle/finalise below.
    let outcome: 'success' | 'failed' | 'cancelled' | null = null;
    if (heist.status === 'recruiting') {
      // The claim freezes the crew (claimed_at), rolls the outcome, and stores
      // payout_each for a success. It no longer freezes a per-heist refund amount:
      // every refund now reads each participant's OWN frozen entry_fee_paid off the
      // participant row, immune to a config edit after the debit, so the claim
      // needs neither the entry fee nor a refund_each column.
      const { data: claimData, error: claimErr } = await this.supabase.rpc('heist_claim_for_resolution', {
        p_heist_id: heistId,
        p_min_participants: minParticipants,
      });
      if (claimErr) {
        // Transient claim error. resolveHeist already deleted this heist's only
        // scheduled resolve timer (top of the method), and the row is still
        // 'recruiting' + expired — but /heist start treats 'recruiting' as an
        // active heist and resumePendingHeists only revisits it on the NEXT bot
        // restart, so a single blip at expiry would block the guild from running
        // heists indefinitely. Re-arm the same bounded in-process retry the
        // settle/finalise error paths use (it re-enters resolveHeist, which
        // re-reads and re-attempts the claim). We NEVER guess an outcome here.
        log.error(`heist_claim_for_resolution failed for ${heistId} — scheduling retry:`, claimErr.message);
        this.scheduleResolveRetry(guildId, heistId, channelId);
        return;
      }
      const claim = Array.isArray(claimData) ? claimData[0] : claimData;
      if (!claim?.claimed) {
        // Another resolver owns this heist. If it is mid-resolution
        // (in_progress), re-read so the settle/finalise pass below can finish
        // a crashed payout idempotently; otherwise it is already terminal.
        const { data: fresh, error: freshErr } = await this.supabase
          .from('economy_heists').select('*').eq('id', heistId).single();
        // A failed re-read is transient, not "already terminal". We lost the claim
        // to a concurrent resolver and must re-read to learn whether it finished
        // or crashed mid-resolution (in_progress). If that read errors and the
        // winner then dies after claiming, the row is left in_progress and
        // /heist start treats it as active, so nothing resolves it until a full
        // restart runs resumePendingHeists. Re-arm the same bounded in-process
        // retry the settle/finalise paths use so a transient blip does not block
        // the guild — never finalise or settle on a read we could not perform.
        if (freshErr) {
          log.error(`Re-read of claim-lost heist ${heistId} failed — scheduling retry:`, freshErr.message);
          this.scheduleResolveRetry(guildId, heistId, channelId);
          return;
        }
        if (!fresh || fresh.status !== 'in_progress') {
          // The winner already drove the heist terminal — nothing left to do and
          // no retry needed. Drop any retry bookkeeping we may have accumulated.
          this.clearRetryState(heistId);
          return;
        }
        Object.assign(heist, fresh);
        outcome = (fresh.resolution as typeof outcome) ?? null;
      } else {
        outcome = claim.outcome as typeof outcome;
        heist.payout_each = claim.payout_each;
      }
    } else if (heist.status === 'in_progress') {
      // Crashed after claim, before finalisation — resume the stored decision.
      // payout_each is already frozen on the row read above, and every refund
      // reads each participant's frozen entry_fee_paid, so the settle pass never
      // re-derives money from config.
      outcome = (heist.resolution as typeof outcome) ?? null;
    } else {
      return;  // success / failed / cancelled — already terminal
    }

    // A legacy in_progress heist from the OLD (pre-atomic) resolver has no frozen
    // resolution. Never guess an outcome — driving it to 'failed' could terminally
    // fail (and announce a loss for) a heist that actually succeeded and paid out
    // under the old code. Leave it in_progress for a dedicated backfill;
    // heist_finalize_resolution likewise refuses a NULL resolution. This covers
    // both the direct-in_progress path and the claim-lost re-read above.
    if (outcome === null) {
      log.warn(`Skipping legacy in_progress heist ${heistId} with NULL resolution — leaving for backfill`);
      return;
    }

    // Authoritative crew: only the FROZEN set stamped by the atomic claim
    // (claimed_at IS NOT NULL). A /heist join whose participant insert raced past
    // the claim is unstamped, so it is neither paid a success share nor
    // refunded/announced as part of an under-crewed cancellation — the settled
    // crew is exactly the v_count the claim decided the payout for.
    const { data: partRows, error: partErr } = await this.supabase
      .from('economy_heist_participants')
      .select('user_id, role, entry_fee_paid')
      .eq('heist_id', heistId)
      .not('claimed_at', 'is', null)
      .limit(1000);
    // A failed crew read must NEVER be treated as "no one to pay/refund".
    // Finalising on an empty list here would flip the heist terminal and
    // silently forfeit every frozen member's payout or refund (they still carry
    // paid_at IS NULL, and no terminal heist is ever revisited). The row is
    // still in_progress with its decision + frozen amounts persisted, so leave
    // it retryable: schedule an in-process retry and let resumePendingHeists
    // recover it on restart. This mirrors a failed credit — a transient read is
    // just as retryable as a transient write.
    if (partErr) {
      log.error(`Frozen-crew read failed for heist ${heistId} (outcome=${outcome}) — leaving in_progress for retry:`, partErr.message);
      this.scheduleResolveRetry(guildId, heistId, channelId);
      return;
    }
    const partList = (partRows ?? []) as Array<{ user_id: string; role: string; entry_fee_paid: number | null }>;
    const participants = partList.map((r) => r.user_id);

    // Reconcile any crash-stranded late joins BEFORE terminalizing (any outcome).
    // Belt-and-braces since 20260710170000 serialized /heist join: heist_join now
    // debits + inserts the participant row in ONE transaction under the heist-row
    // lock, so a join can no longer commit a row after the claim freezes the crew
    // (the primary strand source is closed structurally). This sweep still runs to
    // catch any pre-serialization row, or an unforeseen unstamped-and-unpaid row
    // (claimed_at IS NULL AND paid_at IS NULL) the frozen-crew read above excludes —
    // without it, such a row would finalize with its joiner neither paid nor
    // refunded and the entry fee stranded forever (no terminal heist is ever
    // revisited). heist_reconcile_stranded_joins deletes every such row and refunds
    // its frozen entry fee atomically under the heist-row lock. Idempotent: a frozen
    // member (claimed_at set) is never touched, an already-settled join is already
    // gone, and a re-run finds nothing — so this composes with retry/resume without
    // double-refunding.
    //
    // Refund amount: a stranded late-join must get back exactly the fee IT paid,
    // on ANY outcome. The RPC refunds each stranded row's OWN frozen
    // entry_fee_paid (stamped on the participant at join time) — the same
    // per-participant frozen-fee source the cancelled frozen crew now uses, so
    // every refund path is uniform and immune to a config edit after the debit.
    // p_refund_amount below is only a legacy fallback for pre-freeze rows whose
    // entry_fee_paid is NULL; we pass the current entry fee (the best available
    // approximation for a legacy row). A failed reconcile is treated exactly like
    // the frozen-crew read failure: retryable, NEVER a terminal flip — a stranded
    // fee must not be lost to a transient error.
    const { error: reconcileErr } = await this.supabase.rpc('heist_reconcile_stranded_joins', {
      p_heist_id: heistId, p_refund_amount: entryFee,
    });
    if (reconcileErr) {
      log.error(`Stranded-join reconcile failed for heist ${heistId} (outcome=${outcome}) — leaving in_progress for retry:`, reconcileErr.message);
      this.scheduleResolveRetry(guildId, heistId, channelId);
      return;
    }

    if (outcome === 'cancelled') {
      // Refund each frozen crew member their OWN frozen entry_fee_paid — the exact
      // amount THAT member was charged at join time, stamped on their participant
      // row. This is the unification (codex heist-manager.ts:777): if an admin
      // edits the entry fee during the recruiting window, crew members can have
      // paid DIFFERENT fees, so a single per-heist refund_each would over- or
      // under-refund someone. Reading each row's entry_fee_paid is correct
      // per-member and identical to the source the stranded-join refund uses — one
      // frozen-fee mechanism for every refund path. The ?? entryFee is the legacy
      // fallback for a pre-freeze row whose entry_fee_paid is NULL (same fallback
      // the stranded path uses). heist_credit_participant is idempotent (paid_at
      // guard), so a re-resolve after a crash does not double-refund.
      const failedRefunds: string[] = [];
      for (const part of partList) {
        const uid = part.user_id;
        const refundAmount = part.entry_fee_paid ?? entryFee;
        const { error: refundErr } = await this.supabase.rpc('heist_credit_participant', {
          p_heist_id: heistId, p_guild_id: guildId, p_user_id: uid, p_amount: refundAmount,
        });
        if (refundErr) {
          log.error(`Failed to refund ${uid}:`, refundErr.message);
          failedRefunds.push(uid);
          // Mark for reconciliation (leaves paid_at NULL so a later retry refunds).
          await this.supabase.from('economy_heist_participants')
            .update({ payout_failed: true })
            .eq('heist_id', heistId)
            .eq('user_id', uid);
        }
      }

      // Do NOT finalise (or tell the channel "fees have been refunded") while any
      // refund is still outstanding. The claim left this row 'in_progress' with
      // resolution='cancelled' precisely so an unfinished cancel stays retryable:
      // finalising now would flip it to terminal 'cancelled', after which
      // resumePendingHeists no longer selects it and resolveHeist returns early
      // for terminal statuses — the un-refunded member (paid_at still NULL) would
      // silently lose their entry fee. Leave it in_progress and schedule an
      // in-process retry; heist_credit_participant is idempotent (paid_at guard),
      // so already-refunded crew are not double-paid and only the still-unpaid
      // members are settled on retry. resumePendingHeists recovers it on restart
      // if the in-process retries are exhausted — the frozen 'cancelled' decision
      // persists on the row, so no refund is ever lost.
      if (failedRefunds.length > 0) {
        log.warn(`Heist ${heistId} (cancelled) left in_progress: ${failedRefunds.length} refund(s) failed — scheduling in-process retry`);
        this.scheduleResolveRetry(guildId, heistId, channelId);
        return;
      }

      // Every refund committed — finalise to terminal 'cancelled' once, and
      // announce iff THIS call performed the terminal flip (single-shot). A
      // concurrent resolver or a post-crash resume gets finalized=false and must
      // not re-notify.
      const { data: finalized, error: finErr } = await this.supabase.rpc('heist_finalize_resolution', {
        p_heist_id: heistId,
      });
      if (finErr) {
        log.error(`heist_finalize_resolution failed for cancelled ${heistId}:`, finErr.message);
        // Every refund succeeded but the terminal flip errored — retry in-process
        // so we finalise + notify without waiting for the next restart.
        this.scheduleResolveRetry(guildId, heistId, channelId);
        return;  // leave in_progress; a retry/resume finalises + notifies
      }
      if (finalized !== true) {
        this.clearRetryState(heistId); // another resolver finalised — stop retrying
        return;  // no re-notify
      }
      this.clearRetryState(heistId); // terminal cancel — drop any retry bookkeeping

      // [game-economy-heist] Append-only audit row for the resolve (cancelled +
      // refund) state change.
      eventBus.emit('heist.resolved', guildId, {
        heistId,
        outcome: 'cancelled',
        participantCount: participants.length,
        payoutEach: 0,
      });

      const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [brandedEmbed(kit, {
            intent: 'info',
            title: '🏴‍☠️ Heist Cancelled',
            description:
              `Not enough crew members joined (needed ${minParticipants}, got ${participants.length}).\n` +
              `Entry fees have been refunded.`,
          })],
        });
      }
      return;
    }

    if (outcome === 'success') {
      const perPerson = heist.payout_each ?? 0;

      // Credit each participant idempotently. heist_credit_participant returns
      // false (and skips the wallet write) for anyone already paid, so a
      // crash-then-resume mid-payout finishes without double-crediting.
      const failedPayouts: string[] = [];
      for (const uid of participants) {
        const { error: payErr } = await this.supabase.rpc('heist_credit_participant', {
          p_heist_id: heistId, p_guild_id: guildId, p_user_id: uid, p_amount: perPerson,
        });
        if (payErr) {
          log.error(`Failed to pay ${uid}:`, payErr.message);
          failedPayouts.push(uid);
          // Mark for reconciliation (leaves paid_at NULL so a later retry pays).
          await this.supabase.from('economy_heist_participants')
            .update({ payout_failed: true })
            .eq('heist_id', heistId)
            .eq('user_id', uid);
        }
      }

      // Do NOT finalise while any credit is still outstanding. Finalising would
      // flip the row out of 'in_progress', after which resumePendingHeists no
      // longer selects it and resolveHeist returns early for terminal statuses —
      // the unpaid participant (paid_at still NULL) would never be retried and
      // silently loses their share. Leave the heist in_progress and schedule an
      // in-process retry (bounded backoff); heist_credit_participant is
      // idempotent (paid_at guard), so already-paid crew are not double-credited
      // and only the still-unpaid members are settled on retry. If the in-process
      // retries are exhausted, resumePendingHeists still recovers it on the next
      // restart — the frozen decision persists on the row, so a payout is never lost.
      if (failedPayouts.length > 0) {
        log.warn(`Heist ${heistId} left in_progress: ${failedPayouts.length} payout(s) failed — scheduling in-process retry`);
        this.scheduleResolveRetry(guildId, heistId, channelId);
        return;
      }

      // Finalise once, and announce iff THIS call performed the terminal flip.
      // heist_finalize_resolution returns true only for the caller that moved
      // the row out of 'in_progress'; a concurrent resolver or a post-crash
      // resume gets false and must not re-notify (mirrors lottery gating its
      // announcement on a non-null award result).
      const { data: finalized, error: finErr } = await this.supabase.rpc('heist_finalize_resolution', {
        p_heist_id: heistId,
      });
      if (finErr) {
        log.error(`heist_finalize_resolution failed for ${heistId}:`, finErr.message);
        // Every credit succeeded but the terminal flip errored — retry in-process
        // so we finalise + notify without waiting for the next restart.
        this.scheduleResolveRetry(guildId, heistId, channelId);
        return;  // leave in_progress; a retry/resume finalises + notifies
      }
      if (finalized !== true) {
        this.clearRetryState(heistId); // another resolver finalised — stop retrying
        return;  // no re-notify
      }
      this.clearRetryState(heistId); // terminal success — drop any retry bookkeeping

      // [game-economy-heist] Append-only audit row for the resolve (success +
      // per-crew payout) state change.
      eventBus.emit('heist.resolved', guildId, {
        heistId,
        outcome: 'success',
        participantCount: participants.length,
        payoutEach: perPerson,
      });

      // We only reach here once every credit succeeded (the failedPayouts guard
      // above returns early otherwise), so every crew member is paid.
      const crewList = partList
        .map((p) => `• <@${p.user_id}> — **${p.role}** (+${cEmoji} ${perPerson.toLocaleString()} ${cName})`)
        .join('\n');

      const story = randomPick(SUCCESS_STORIES);

      const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [brandedEmbed(kit, {
            intent: 'primary',
            title: `✅ Heist Success: ${heist.target_name}`,
            description:
              `${story}\n\n` +
              `💰 Total haul: ${cEmoji} **${heist.target_payout.toLocaleString()}** ${cName}\n\n` +
              `**Crew Payouts:**\n${crewList}`,
          })],
        });
      }
      return;
    }

    // outcome === 'failed' — entry fees are forfeit; nothing to credit.
    // Announce iff THIS call performed the terminal flip (single-shot).
    const { data: finalized, error: finErr } = await this.supabase.rpc('heist_finalize_resolution', {
      p_heist_id: heistId,
    });
    if (finErr) {
      log.error(`heist_finalize_resolution failed for ${heistId}:`, finErr.message);
      // Retryable: the row is still in_progress with resolution='failed' frozen.
      this.scheduleResolveRetry(guildId, heistId, channelId);
      return;
    }
    if (finalized !== true) {
      this.clearRetryState(heistId);
      return;  // another resolver already finalised — no re-notify
    }
    this.clearRetryState(heistId); // terminal failure — drop any retry bookkeeping

    // [game-economy-heist] Append-only audit row for the resolve (failed —
    // entry fees forfeit) state change.
    eventBus.emit('heist.resolved', guildId, {
      heistId,
      outcome: 'failed',
      participantCount: participants.length,
      payoutEach: 0,
    });

    const story = randomPick(FAIL_STORIES);
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (channel) {
      await channel.send({
        embeds: [brandedEmbed(kit, {
          intent: 'danger',
          title: `❌ Heist Failed: ${heist.target_name}`,
          description:
            `${story}\n\n` +
            `👥 ${participants.map((id) => `<@${id}>`).join(', ')}\n\n` +
            `Each crew member lost their ${cEmoji} **${entryFee.toLocaleString()}** ${cName} entry fee.`,
        })],
      });
    }
  }

  /** Re-schedule pending heists on bot restart */
  async resumePendingHeists(guildId: string): Promise<void> {
    // Include 'in_progress' heists: a crash after the atomic claim but before
    // finalisation leaves the row 'in_progress' with its outcome frozen. Those
    // must be resumed too, or they strand forever (never paid, never notified).
    // resolveHeist is idempotent — heist_credit_participant and
    // heist_finalize_resolution ensure a resumed in_progress heist pays each
    // crew member exactly once and finalises exactly once.
    const { data: pending } = await this.supabase
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .in('status', ['recruiting', 'in_progress'])
      .limit(1000);

    for (const heist of pending ?? []) {
      // in_progress heists were already claimed — resolve immediately to
      // finish their frozen outcome; don't wait out the (elapsed) join window.
      const remaining = heist.status === 'in_progress'
        ? 0
        : new Date(heist.expires_at).getTime() - Date.now();
      if (remaining <= 0) {
        // Expired while offline — resolve immediately
        // Find the channel from the initiator's last message context — use log channel as fallback
        const { config } = await this.getConfig(guildId);
        const channelId = config?.economy_log_channel_id ?? '';
        await this.resolveHeist(guildId, heist.id, channelId);
      } else {
        const { config } = await this.getConfig(guildId);
        const channelId = config?.economy_log_channel_id ?? '';
        const timer = setTimeout(async () => {
          try {
            await this.resolveHeist(guildId, heist.id, channelId);
          } catch (err) {
            log.error(`Failed to resolve pending heist ${heist.id} in guild ${guildId}:`, err);
          }
        }, remaining);
        this.resolveTimers.set(heist.id, timer);
      }
    }
  }
}
