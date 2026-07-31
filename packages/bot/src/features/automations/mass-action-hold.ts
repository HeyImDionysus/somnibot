import type { Guild, TextChannel } from 'discord.js';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import type { AutomationAction } from './action-executor.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('MassActionHold');

export const MASS_ACTION_THRESHOLD = 25;

export interface MassActionContextSnapshot {
  channelId: string | null;
  messageId: string | null;
  variables: Record<string, string>;
  /** Chain depth the released execution resumes at (MAX_CHAIN_DEPTH guard). */
  chainDepth?: number;
}

export interface MassActionHoldRow {
  id: string;
  guild_id: string;
  automation_id: string;
  execution_id: string | null;
  occurrence_id: string;
  status: 'held' | 'approved' | 'executing' | 'completed' | 'rejected' | 'failed';
  member_ids: string[];
  member_count: number;
  threshold: number;
  trigger_event: string;
  triggered_by: string;
  action_snapshot: AutomationAction[];
  context_snapshot: MassActionContextSnapshot;
  notification_message_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  execution_started_at: string | null;
  execution_owner_token: string | null;
  execution_lease_expires_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMassActionHoldInput {
  automationId: string;
  executionId: string | null;
  occurrenceId: string;
  memberIds: string[];
  threshold: number;
  triggerEvent: string;
  triggeredBy: string;
  actions: AutomationAction[];
  context: MassActionContextSnapshot;
}

function isConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/**
 * Owns persistence and recovery for held bulk automation occurrences.
 * Execution remains in AutomationEngine so the same action runner and audit
 * behavior are used before and after a restart.
 */
/**
 * Age past which a `pending:` notice-delivery claim is treated as a dead
 * holder's leftovers. A live send completes in seconds.
 */
const STALE_NOTICE_CLAIM_MS = 10 * 60_000;

export class MassActionHoldService {
  private channel: RealtimeChannel | null = null;
  private approvedPoller: NodeJS.Timeout | null = null;
  private approvalHandler: ((holdId: string) => void) | null = null;
  private approvedScanInFlight = false;
  private readonly executionOwnerToken = randomUUID();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly guild: Guild,
  ) {}

  async threshold(): Promise<number> {
    const { data, error } = await this.supabase
      .from('guild_config')
      .select('automation_mass_action_threshold')
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (error) throw new Error(`Failed to read mass-action threshold: ${error.message}`);
    const value = Number(data?.automation_mass_action_threshold ?? MASS_ACTION_THRESHOLD);
    return Number.isInteger(value) && value >= 1 && value <= 500
      ? value
      : MASS_ACTION_THRESHOLD;
  }

  async create(input: CreateMassActionHoldInput): Promise<{
    created: boolean;
    hold: MassActionHoldRow;
  }> {
    const uniqueMemberIds = [...new Set(input.memberIds)];
    const payload = {
      guild_id: this.guild.id,
      automation_id: input.automationId,
      execution_id: input.executionId,
      occurrence_id: input.occurrenceId,
      member_ids: uniqueMemberIds,
      member_count: uniqueMemberIds.length,
      threshold: input.threshold,
      trigger_event: input.triggerEvent,
      triggered_by: input.triggeredBy,
      action_snapshot: input.actions,
      context_snapshot: input.context,
    };
    const { data, error } = await this.supabase
      .from('automation_mass_action_holds')
      .insert(payload)
      .select('*')
      .single();

    if (!error && data) {
      return { created: true, hold: data as MassActionHoldRow };
    }
    if (!isConflict(error)) {
      throw new Error(`Failed to persist mass-action hold: ${error?.message ?? 'missing row'}`);
    }

    const { data: existing, error: readError } = await this.supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('automation_id', input.automationId)
      .eq('occurrence_id', input.occurrenceId)
      .single();
    if (readError || !existing) {
      throw new Error(`Failed to recover mass-action hold: ${readError?.message ?? 'missing row'}`);
    }
    return { created: false, hold: existing as MassActionHoldRow };
  }

  async findByOccurrence(
    automationId: string,
    occurrenceId: string,
  ): Promise<MassActionHoldRow | null> {
    const { data, error } = await this.supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('automation_id', automationId)
      .eq('occurrence_id', occurrenceId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to verify mass-action hold persistence: ${error.message}`);
    }
    return (data as MassActionHoldRow | null) ?? null;
  }

  async listHeldNeedingNotice(): Promise<MassActionHoldRow[]> {
    // Notice recovery only. Delivered cards (a real notification_message_id)
    // need no work, and a bounded oldest-first scan that includes them starves:
    // 500 old delivered holds would hide a newer hold whose notice failed.
    // Undelivered (null) and claim sentinels (pending:*, fresh or stale) are
    // exactly the rows ensureOwnerNotice can act on.
    const { data, error } = await this.supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'held')
      .or('notification_message_id.is.null,notification_message_id.like.pending:*')
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw new Error(`Failed to load held mass actions: ${error.message}`);
    return (data ?? []) as MassActionHoldRow[];
  }

  async listApproved(): Promise<MassActionHoldRow[]> {
    const { data, error } = await this.supabase
      .from('automation_mass_action_holds')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'approved')
      .order('approved_at', { ascending: true })
      .limit(500);
    if (error) throw new Error(`Failed to load approved mass actions: ${error.message}`);
    return (data ?? []) as MassActionHoldRow[];
  }

  async failInterruptedExecutions(): Promise<void> {
    const { error } = await this.supabase.rpc(
      'fail_stale_automation_mass_action_executions',
      { p_guild_id: this.guild.id },
    );
    if (error) {
      throw new Error(`Failed to reconcile interrupted mass actions: ${error.message}`);
    }
  }

  async claimApproved(holdId: string): Promise<MassActionHoldRow | null> {
    const { data, error } = await this.supabase.rpc(
      'claim_approved_automation_mass_action_hold',
      {
        p_hold_id: holdId,
        p_guild_id: this.guild.id,
        p_owner_token: this.executionOwnerToken,
      },
    );
    if (error) throw new Error(`Failed to claim approved mass action: ${error.message}`);
    const rows = Array.isArray(data) ? data : [];
    return (rows[0] as MassActionHoldRow | undefined) ?? null;
  }

  async renewExecutionLease(holdId: string): Promise<void> {
    const { data, error } = await this.supabase.rpc(
      'renew_automation_mass_action_hold_lease',
      {
        p_hold_id: holdId,
        p_guild_id: this.guild.id,
        p_owner_token: this.executionOwnerToken,
      },
    );
    if (error) throw new Error(`Failed to renew mass-action execution lease: ${error.message}`);
    if (data !== true) throw new Error('Mass-action execution lease is no longer owned by this worker');
  }

  async complete(holdId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('automation_mass_action_holds')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        last_error: null,
        execution_owner_token: null,
        execution_lease_expires_at: null,
      })
      .eq('id', holdId)
      .eq('guild_id', this.guild.id)
      .eq('status', 'executing')
      .eq('execution_owner_token', this.executionOwnerToken)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Failed to complete mass-action hold: ${error.message}`);
    if (!data) throw new Error('Mass-action hold completion rejected because its lease was lost');
  }

  async fail(holdId: string, errorMessage: string): Promise<void> {
    const { error } = await this.supabase
      .from('automation_mass_action_holds')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        last_error: errorMessage,
        execution_owner_token: null,
        execution_lease_expires_at: null,
      })
      .eq('id', holdId)
      .eq('guild_id', this.guild.id)
      .eq('status', 'executing')
      .eq('execution_owner_token', this.executionOwnerToken);
    if (error) log.error('Failed to mark mass-action hold failed:', error.message);
  }

  async pruneTerminal(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const { data: candidates, error: readError } = await this.supabase
      .from('automation_mass_action_holds')
      .select('id')
      .eq('guild_id', this.guild.id)
      .in('status', ['completed', 'rejected', 'failed'])
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(500);
    if (readError) throw new Error(`Failed to select terminal mass-action holds: ${readError.message}`);
    const ids = (candidates ?? [])
      .map((row) => row.id as string | undefined)
      .filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return 0;
    const { error: deleteError } = await this.supabase
      .from('automation_mass_action_holds')
      .delete()
      .eq('guild_id', this.guild.id)
      .in('id', ids);
    if (deleteError) throw new Error(`Failed to prune terminal mass-action holds: ${deleteError.message}`);
    return ids.length;
  }

  /**
   * Deliver one stable owner notice. A retry first scans recent messages for
   * the hold footer; this closes the crash window between Discord accepting a
   * message and Postgres storing its id without posting a second card.
   */
  async ensureOwnerNotice(hold: MassActionHoldRow, automationName: string): Promise<void> {
    if (hold.notification_message_id) {
      if (!hold.notification_message_id.startsWith('pending:')) return; // delivered
      // A delivery CLAIM, not a message id. Fresh → a live path is mid-send,
      // leave it alone. Stale → that path died between claiming and sending;
      // release the exact sentinel (CAS) and fall through to claim delivery
      // ourselves. Without this, a crash inside the claim window would strand
      // the owner notice behind the delivered-check forever.
      const claimedAtMs = Number(hold.notification_message_id.split(':')[2]);
      if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < STALE_NOTICE_CLAIM_MS) {
        return;
      }
      const { error: releaseError } = await this.supabase
        .from('automation_mass_action_holds')
        .update({ notification_message_id: null })
        .eq('id', hold.id)
        .eq('guild_id', this.guild.id)
        .eq('notification_message_id', hold.notification_message_id);
      if (releaseError) {
        throw new Error(`Failed to release stale notice claim: ${releaseError.message}`);
      }
    }
    const { data: config, error: configError } = await this.supabase
      .from('guild_config')
      .select('alert_channel_id')
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (configError) throw new Error(`Failed to read owner alert channel: ${configError.message}`);
    const channelId = config?.alert_channel_id as string | null | undefined;
    if (!channelId) return;
    const channel = this.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const textChannel = channel as TextChannel;
    const footerText = `SomniBot • Mass-action hold ${hold.id}`;
    const recent = await textChannel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = recent?.find((message) =>
      message.embeds.some((embed) => embed.footer?.text === footerText),
    );
    if (existing) {
      // A card already exists (crash landed between send and record). Adopt
      // its id; the conditional update below keeps whoever recorded first.
      const { error } = await this.supabase
        .from('automation_mass_action_holds')
        .update({ notification_message_id: existing.id })
        .eq('id', hold.id)
        .eq('guild_id', this.guild.id)
        .is('notification_message_id', null);
      if (error) throw new Error(`Failed to record mass-action owner notice: ${error.message}`);
      return;
    }

    // CLAIM delivery before calling Discord. Two concurrent recovery paths
    // (rolling deploy, periodic scan overlapping the creation path) can both
    // pass the message scan above before either has posted — recording the id
    // only AFTER the send then merely elects which duplicate card's id is
    // stored, it cannot unsend the other one. The claim is a conditional write
    // of a sentinel; exactly one caller wins the NULL row and sends.
    const claimSentinel = `pending:${hold.id}:${Date.now()}`;
    const { data: claimedRows, error: claimError } = await this.supabase
      .from('automation_mass_action_holds')
      .update({ notification_message_id: claimSentinel })
      .eq('id', hold.id)
      .eq('guild_id', this.guild.id)
      .is('notification_message_id', null)
      .select('id');
    if (claimError) throw new Error(`Failed to claim mass-action owner notice: ${claimError.message}`);
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) return; // another path owns delivery

    let message;
    try {
      message = await textChannel.send({
        embeds: [{
          title: '🛑 Automation held for approval',
          description:
            `Held automation **${automationName}**: it tried to affect ` +
            `**${hold.member_count} members** at once, above the **${hold.threshold}** guardrail.\n\n` +
            'No member-targeted action ran. Approve or reject this occurrence from the Automations dashboard.',
          color: 0xffa500,
          footer: { text: footerText },
          timestamp: new Date(hold.created_at).toISOString(),
        }],
        allowedMentions: { parse: [] },
      });
    } catch (sendError) {
      // Release the claim so a later pass can retry delivery; the footer scan
      // above still guards the crash window inside Discord itself.
      await this.supabase
        .from('automation_mass_action_holds')
        .update({ notification_message_id: null })
        .eq('id', hold.id)
        .eq('guild_id', this.guild.id)
        .eq('notification_message_id', claimSentinel);
      throw sendError;
    }

    const { error } = await this.supabase
      .from('automation_mass_action_holds')
      .update({ notification_message_id: message.id })
      .eq('id', hold.id)
      .eq('guild_id', this.guild.id)
      .eq('notification_message_id', claimSentinel);
    if (error) throw new Error(`Failed to record mass-action owner notice: ${error.message}`);
  }

  private async scanApproved(): Promise<void> {
    if (this.approvedScanInFlight || !this.approvalHandler) return;
    this.approvedScanInFlight = true;
    try {
      const approved = await this.listApproved();
      for (const hold of approved) this.approvalHandler(hold.id);
    } catch (err) {
      log.error('Failed to poll approved mass-action holds:', {
        error: String(err),
      });
    } finally {
      this.approvedScanInFlight = false;
    }
  }

  async subscribe(onApproved: (holdId: string) => void): Promise<void> {
    this.approvalHandler = onApproved;
    if (!this.approvedPoller) {
      this.approvedPoller = setInterval(() => {
        void this.scanApproved();
      }, 30_000);
      this.approvedPoller.unref?.();
    }

    let settle!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, rejectReady) => {
      settle = resolve;
      reject = rejectReady;
    });
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for mass-action Realtime subscription'));
    }, 15_000);
    timeout.unref?.();

    this.channel = this.supabase
      .channel(`automation-mass-action-holds-${this.guild.id}-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'automation_mass_action_holds',
          filter: `guild_id=eq.${this.guild.id}`,
        },
        (payload) => {
          const row = payload.new as Partial<MassActionHoldRow>;
          if (row.status === 'approved' && row.id) onApproved(row.id);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') settle();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          reject(new Error(`Mass-action Realtime subscription ended with ${status}`));
        }
      });

    try {
      await ready;
    } finally {
      clearTimeout(timeout);
    }
  }

  unsubscribe(): void {
    if (this.approvedPoller) {
      clearInterval(this.approvedPoller);
      this.approvedPoller = null;
    }
    this.approvalHandler = null;
    if (this.channel) {
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}
