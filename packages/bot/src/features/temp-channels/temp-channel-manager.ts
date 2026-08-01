/**
 * TempChannelManager — manages hub config + active temp channels in Supabase.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type VoiceChannel,
  type TextChannel,
  type CategoryChannel,
  type GuildMember,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { writeAuditLog } from '../../services/audit.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { renderTempChannelTemplate } from './templates.js';
import {
  claimDiscordOccurrence,
  completeDiscordOccurrence,
  failDiscordOccurrence,
  markDiscordOccurrenceCleanupPending,
  recordDiscordOccurrenceChannels,
  reclaimStaleDiscordOccurrence,
  releaseDiscordOccurrence,
  type DiscordOperationOccurrence,
} from '../../services/occurrence-fence.js';

const log = createLogger('TempChannels');
const CLEANUP_RETRY_BASE_MS = 5_000;
const CLEANUP_RETRY_MAX_MS = 60_000;
const CLEANUP_RETRY_LIMIT = 5;
const CREATION_CLAIM_LEASE_MS = 2 * 60_000;
const PENDING_CHANNEL_CLEANUP_INTERVAL_MS = 5 * 60_000;


export interface HubConfig {
  id: string;
  guild_id: string;
  hub_channel_id: string;
  category_id: string;
  naming_format: string;
  default_user_limit: number;
  default_bitrate: number;
  keep_alive_minutes: number;
  empty_grace_seconds: number | null;
  allow_text_channel: boolean;
  allow_claim: boolean;
  moderator_roles: string[];
  active: boolean;
  // Owner-brandable member-facing templates (null/blank ⇒ built-in default).
  room_created_template: string | null;
  control_applied_template: string | null;
  control_denied_template: string | null;
}

export interface ActiveTempChannel {
  channel_id: string;
  text_channel_id: string | null;
  guild_id: string;
  hub_id: string;
  owner_id: string;
  creation_occurrence_id?: string | null;
}

export class TempChannelManager {
  private hubs: Map<string, HubConfig> = new Map(); // hub_channel_id → config
  private activeChannels: Map<string, ActiveTempChannel> = new Map(); // channel_id → active
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
  private inFlightJoins: Set<string> = new Set(); // `${memberId}:${hubChannelId}` currently spawning
  private pendingChannelCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus = defaultEventBus,
  ) {}

  async start(): Promise<void> {
    // Load hub configs
    const { data: hubs } = await this.supabase
      .from('temp_channel_hubs')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (hubs) {
      for (const hub of hubs) {
        this.hubs.set(hub.hub_channel_id, hub as HubConfig);
      }
    }

    // Load active temp channels (in case of restart)
    const { data: active } = await this.supabase
      .from('active_temp_channels')
      .select('*')
      .eq('guild_id', this.guild.id)
      .limit(1000);

    if (active) {
      for (const ch of active) {
        this.activeChannels.set(ch.channel_id, ch as ActiveTempChannel);
      }
    }

    // Clean up any orphaned channels. Initial cleanup is best-effort and MUST
    // NOT throw out of start(): guild-init awaits start() inside the single
    // shared community-features try, so a transient database error here used to
    // take down not just temp channels but stats channels, scheduled messages
    // and giveaways for the lifetime of the guild context. The periodic timer
    // below retries the same reconciliation every five minutes, so a failed
    // first pass costs one interval, not the feature set.
    try {
      await this.cleanupOrphans();
      await this.reconcilePendingChannelCleanup();
    } catch (error) {
      log.error('Initial temp-channel cleanup failed; periodic reconciliation will retry:', {
        error: String(error),
      });
    }
    if (!this.pendingChannelCleanupTimer) {
      this.pendingChannelCleanupTimer = setInterval(() => {
        // Both halves retry here, each contained. cleanupOrphans matters just
        // as much as the occurrence reconcile: a stale active_temp_channels
        // row whose Discord channel is gone is an ACTIVE record, not a
        // cleanup-pending occurrence — if its startup retirement failed
        // transiently, nothing else would ever retry it before the next
        // process restart.
        void (async () => {
          try {
            await this.cleanupOrphans();
          } catch (error) {
            log.error('Periodic orphan cleanup failed:', { error: String(error) });
          }
          try {
            await this.reconcilePendingChannelCleanup();
          } catch (error) {
            log.error('Temp-channel cleanup reconciliation failed:', { error: String(error) });
          }
        })();
      }, PENDING_CHANNEL_CLEANUP_INTERVAL_MS);
      this.pendingChannelCleanupTimer.unref();
    }

    log.info(`Loaded ${this.hubs.size} hubs, ${this.activeChannels.size} active channels`);
  }

  isHubChannel(channelId: string): boolean {
    return this.hubs.has(channelId);
  }

  isTempChannel(channelId: string): boolean {
    return this.activeChannels.has(channelId);
  }

  getChannelOwner(channelId: string): string | null {
    return this.activeChannels.get(channelId)?.owner_id ?? null;
  }

  getHubForChannel(channelId: string): HubConfig | null {
    const active = this.activeChannels.get(channelId);
    if (!active) return null;
    for (const hub of this.hubs.values()) {
      if (hub.id === active.hub_id) return hub;
    }
    return null;
  }

  /**
   * Durably record surviving channel ids as a cleanup-pending job, with
   * bounded retries. Returns true when the job landed. Callers that receive
   * false must leave the occurrence CLAIMED — `failed` is terminal and the
   * reconciler scans only claimed cleanup-pending rows, so terminalizing here
   * orphans the survivors invisibly and forever.
   */
  /**
   * Delete created channels with per-channel retries; returns the ids that
   * still survive. A single rejected attempt must not demote a survivor to
   * the durable-pointer path when a transient Discord fault would have
   * cleared it on the next try — a TEXT survivor especially, which stale
   * recovery's voice-channel heuristic can never find without its id.
   */
  private async deleteCreatedChannels(
    targets: Array<{ channelId: string; remove: () => Promise<unknown> }>,
  ): Promise<string[]> {
    const survivors: string[] = [];
    for (const target of targets) {
      let deleted = false;
      for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
        try {
          await target.remove();
          deleted = true;
        } catch (deleteError) {
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          } else {
            log.warn('Created temp channel resisted deletion after retries:', {
              channelId: target.channelId,
              error: String(deleteError),
            });
          }
        }
      }
      if (!deleted) survivors.push(target.channelId);
    }
    return survivors;
  }

  private async persistCleanupJob(
    occurrenceId: string,
    survivingChannelIds: string[],
    cause: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await markDiscordOccurrenceCleanupPending(
          this.supabase,
          occurrenceId,
          survivingChannelIds[0],
          cause,
          {
            stage: 'active_row_insert',
            channelIds: survivingChannelIds,
          },
        );
        return true;
      } catch (persistError) {
        if (attempt === 3) {
          log.error(
            'Could not persist temp-channel cleanup job after retries; '
            + 'leaving the occurrence claimed so the survivors are not silently disowned:',
            {
              occurrenceId,
              survivingChannelIds,
              error: String(persistError),
            },
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    return false;
  }

  /**
   * Handle a user joining a hub voice channel.
   */
  async handleJoinHub(
    member: GuildMember,
    hubChannelId: string,
    occurrenceKey?: string,
  ): Promise<void> {
    let occurrenceClaimUpdatedAt: string | null = null;
    const hub = this.hubs.get(hubChannelId);
    if (!hub) return;

    // If this owner already has a live room for the hub, reuse it. This is both
    // friendlier on a gateway replay and a recovery path after a bot restart.
    const existingActive = [...this.activeChannels.values()].find(
      (active) => active.owner_id === member.id && active.hub_id === hub.id,
    );
    if (existingActive) {
      const existingChannel = this.guild.channels.cache.get(existingActive.channel_id);
      if (existingChannel) {
        await member.voice.setChannel(existingChannel as VoiceChannel);
        return;
      }
      await this.removeChannel(existingActive.channel_id);
    }

    // Join-event idempotency: a re-delivered voiceStateUpdate (Discord gateway
    // resume/reconnect can re-emit the same hub-join) must not spawn a SECOND
    // room. A fresh create yields a new channel id, so the active_temp_channels
    // PK gives no protection — guard on an in-flight key keyed by member+hub.
    const joinKey = `${member.id}:${hubChannelId}`;
    if (this.inFlightJoins.has(joinKey)) return;
    this.inFlightJoins.add(joinKey);
    let occurrenceId: string | null = null;
    let externalRoomExists = false;
    let activeRecordCommitted = false;
    let cleanupJobCommitted = false;
    // Set when the cleanup-pending write was attempted and exhausted its
    // retries. The outer catch must then leave the occurrence CLAIMED: routing
    // this through failDiscordOccurrence would terminalize the claim with the
    // surviving channel ids recorded nowhere, and the periodic reconciler only
    // scans claimed rows flagged channelCleanupPending — the survivors would be
    // orphaned invisibly and forever.
    let cleanupPersistExhausted = false;

    // Format channel name. The catalog's single documented variable is
    // {owner-name}; {username}/{user}/{tag}/{count} are supported aliases.
    const channelName = hub.naming_format
      .replace(/\{owner-name\}/g, member.displayName)
      .replace(/\{username\}/g, member.displayName)
      .replace(/\{user\}/g, member.displayName)
      .replace(/\{tag\}/g, member.user.username)
      .replace(/\{count\}/g, String(this.activeChannels.size + 1));

    try {
      if (occurrenceKey) {
        const claim = await claimDiscordOccurrence(
          this.supabase,
          this.guild.id,
          'temp_channel',
          occurrenceKey,
          {
            recoveryKind: 'temp_channel_create',
            hubId: hub.id,
            hubChannelId,
            categoryId: hub.category_id,
            ownerId: member.id,
            channelName,
            pairedTextName: hub.allow_text_channel ? `${channelName}-chat` : null,
          },
        );
        occurrenceId = claim.occurrence.id;
        occurrenceClaimUpdatedAt = claim.occurrence.updated_at ?? null;
        if (!claim.won) {
          const { data: existing } = await this.supabase
            .from('active_temp_channels')
            .select('*')
            .eq('creation_occurrence_id', occurrenceId)
            .maybeSingle();
          if (existing?.channel_id && existing.owner_id === member.id) {
            const existingChannel = this.guild.channels.cache.get(existing.channel_id);
            if (existingChannel) {
              this.activeChannels.set(existing.channel_id, existing as ActiveTempChannel);
              await member.voice.setChannel(existingChannel as VoiceChannel);
            }
            return;
          }

          const recovery = await this.recoverStaleCreationClaim(
            claim.occurrence,
            member,
            hub,
          );
          if (recovery === 'recovered') {
            return;
          }
          if (recovery !== 'reclaimed') {
            // A fresh claim, terminal outcome, unverifiable Discord snapshot,
            // or a lost CAS remains fail-closed.
            return;
          }
        }
      }

      const category = this.guild.channels.cache.get(hub.category_id) as CategoryChannel | undefined;

      // Create the voice channel. A single transient failure must not leave the
      // member with no room — retry briefly so at most one room per join event.
      const vc = await this.withRetry(
        () =>
          this.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            parent: category ?? undefined,
            userLimit: hub.default_user_limit || undefined,
            bitrate: hub.default_bitrate,
            permissionOverwrites: [
              {
                id: member.id,
                allow: [
                  PermissionFlagsBits.ManageChannels,
                  PermissionFlagsBits.MoveMembers,
                  PermissionFlagsBits.MuteMembers,
                  PermissionFlagsBits.DeafenMembers,
                ],
              },
            ],
          }),
        'temp channel create',
      );
      externalRoomExists = true;

      let textChannelId: string | null = null;
      let textChannel: TextChannel | null = null;

      // Optionally create a paired text channel
      if (hub.allow_text_channel) {
        try {
          textChannel = await this.guild.channels.create({
            name: `${channelName}-chat`,
            type: ChannelType.GuildText,
            parent: category ?? undefined,
            permissionOverwrites: [
              {
                id: this.guild.id, // @everyone
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: member.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ManageMessages,
                ],
              },
            ],
          });
          textChannelId = textChannel.id;
        } catch (err) {
          log.error('Failed to create text channel:', { error: String(err) });
        }
      }

      // Make the created channel ids DURABLE on the claim before anything else
      // can fail. If the active-row insert, a deletion, and every
      // cleanup-pending write all failed, the claim used to name no survivor:
      // stale recovery found nothing, reclaimed the occurrence, and spawned a
      // fresh room while the survivor stayed orphaned forever. If this write
      // itself cannot land after retries, abort while the channels are seconds
      // old and cheap to delete — never proceed into a state that cannot be
      // recovered.
      if (occurrenceId) {
        let idsPersisted = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await recordDiscordOccurrenceChannels(
              this.supabase,
              occurrenceId,
              [vc.id, ...(textChannelId ? [textChannelId] : [])],
            );
            idsPersisted = true;
            break;
          } catch (persistError) {
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            } else {
              log.error('Could not persist created channel ids; aborting room creation:', {
                occurrenceId,
                error: String(persistError),
              });
            }
          }
        }
        if (!idsPersisted) {
          const abortTargets = [
            {
              channelId: vc.id,
              remove: () => vc.delete('Temp channel id persistence failed'),
            },
            ...(textChannel
              ? [{
                  channelId: textChannel.id,
                  remove: () => textChannel.delete('Temp channel id persistence failed'),
                }]
              : []),
          ];
          const abortSurvivors = await this.deleteCreatedChannels(abortTargets);
          if (abortSurvivors.length === 0) {
            externalRoomExists = false;
          } else {
            // Retried abort deletions still left survivors with NO ids on
            // the claim (the id write is what just failed). Falling through to
            // the outer catch would terminalize the occurrence as `failed` —
            // and the reconciler scans only claimed cleanup-pending rows, so
            // the survivors would be orphaned permanently. Route them through
            // the same durable cleanup machinery as the insert-failure branch.
            cleanupJobCommitted = await this.persistCleanupJob(
              occurrenceId,
              abortSurvivors,
              'Temp-channel id persistence failed and abort deletion was rejected',
            );
            if (!cleanupJobCommitted) {
              // Neither Discord nor the database will take the survivors.
              // A DELETED channel needs no pointer — try Discord once more
              // before accepting the claimed-but-unidentifiable floor.
              const finalSurvivors = await this.deleteCreatedChannels(
                abortTargets.filter((target) => abortSurvivors.includes(target.channelId)),
              );
              if (finalSurvivors.length === 0) {
                externalRoomExists = false;
              } else {
                cleanupPersistExhausted = true;
              }
            }
          }
          throw new Error('Failed to persist created temp-channel identities');
        }
      }

      // Record in DB
      const record: ActiveTempChannel = {
        channel_id: vc.id,
        text_channel_id: textChannelId,
        guild_id: this.guild.id,
        hub_id: hub.id,
        owner_id: member.id,
        creation_occurrence_id: occurrenceId,
      };

      // The ownership insert is SERIALIZED against stale reclaim: the RPC
      // locks the occurrence row and verifies this worker's claim identity
      // (updated_at snapshot) before inserting. A reclaim that won the race
      // returns ownershipLost instead of silently inserting a row recovery
      // will never see.
      let recordError: { message: string } | null = null;
      let ownershipLost = false;
      if (occurrenceId && occurrenceClaimUpdatedAt) {
        const { data: inserted, error: rpcError } = await this.supabase.rpc(
          'insert_owned_temp_channel',
          {
            p_occurrence_id: occurrenceId,
            p_expected_updated_at: occurrenceClaimUpdatedAt,
            p_channel_id: record.channel_id,
            p_text_channel_id: record.text_channel_id,
            p_guild_id: record.guild_id,
            p_hub_id: record.hub_id,
            p_owner_id: record.owner_id,
          },
        );
        if (rpcError) {
          recordError = { message: rpcError.message };
        } else if (inserted !== true) {
          ownershipLost = true;
        }
      } else {
        const { error: plainError } = await this.supabase
          .from('active_temp_channels')
          .insert(record);
        recordError = plainError ? { message: plainError.message } : null;
      }
      if (ownershipLost) {
        // Stale recovery reclaimed this occurrence while we were creating
        // channels: OUR channels are the duplicates now. Delete them and walk
        // away without touching the occurrence — it belongs to recovery.
        log.warn('Temp-room creation lost its claim to stale recovery; removing duplicates', {
          occurrenceId,
          channelId: vc.id,
        });
        const targets = [
          { channelId: vc.id, remove: () => vc.delete('Temp channel claim was reclaimed') },
          ...(textChannel
            ? [{
                channelId: textChannel.id,
                remove: () => textChannel.delete('Temp channel claim was reclaimed'),
              }]
            : []),
        ];
        await this.deleteCreatedChannels(targets);
        return;
      }
      if (recordError && occurrenceId) {
        // The insert response can be lost AFTER commit. If a durable row now
        // owns these channels, deleting them would leave that committed row
        // pointing at nothing — and it never entered activeChannels, so the
        // periodic orphan cleanup would not retire it either. Read back by
        // the creation occurrence before treating the insert as absent.
        const { data: committed, error: readBackError } = await this.supabase
          .from('active_temp_channels')
          .select('channel_id')
          .eq('guild_id', this.guild.id)
          .eq('creation_occurrence_id', occurrenceId)
          .maybeSingle();
        if (!readBackError && committed?.channel_id === vc.id) {
          recordError = null;
        } else if (readBackError) {
          // The insert outcome is UNRESOLVED: a transient read failure is not
          // confirmed absence, and deleting could destroy channels a
          // committed row already owns. Preserve everything — the claim stays
          // CLAIMED and the durable createdChannelIds let stale recovery
          // adopt or dispose once the database answers authoritatively.
          cleanupPersistExhausted = true;
          throw new Error(
            `Temp-channel record outcome unresolved: ${recordError.message}`,
          );
        }
      }
      if (recordError) {
        const cleanup: Array<{ channelId: string; remove: () => Promise<unknown> }> = [
          {
            channelId: vc.id,
            remove: () => vc.delete('Temp channel database record failed'),
          },
        ];
        if (textChannel) {
          cleanup.push({
            channelId: textChannel.id,
            remove: () => textChannel.delete('Temp channel database record failed'),
          });
        }
        const survivingChannelIds = await this.deleteCreatedChannels(cleanup);
        if (survivingChannelIds.length === 0) {
          externalRoomExists = false;
        } else if (occurrenceId) {
          // The cleanup-pending write is the ONLY durable record of the
          // surviving channel ids, so a transient database blip here must not
          // surface as a throw: the outer catch cannot tell it apart from any
          // other failure and would terminalize the claim. Retry in place;
          // on exhaustion, record that fact so the outer catch preserves the
          // claim instead of failing it.
          cleanupJobCommitted = await this.persistCleanupJob(
            occurrenceId,
            survivingChannelIds,
            `Temp-channel database record failed: ${recordError.message}`,
          );
          if (!cleanupJobCommitted) cleanupPersistExhausted = true;
        }
        throw new Error(`Failed to record temp channel: ${recordError.message}`);
      }
      this.activeChannels.set(vc.id, record);
      activeRecordCommitted = true;
      if (occurrenceId) {
        await completeDiscordOccurrence(
          this.supabase,
          occurrenceId,
          vc.id,
          { textChannelId },
        ).catch((err) => {
          // The active row already carries creation_occurrence_id and is the
          // recovery source if this final status write is interrupted.
          log.error('Failed to complete temp-channel occurrence:', { error: String(err) });
        });
      }

      this.eventBus.emit('temp_channel.created', this.guild.id, {
        channelId: vc.id,
        textChannelId,
        hubId: hub.id,
        hubChannelId: hub.hub_channel_id,
        ownerId: member.id,
      });

      // Move the member to the new channel
      await member.voice.setChannel(vc);

      // Post the (owner-brandable) welcome into the new room. Best-effort — a
      // send failure must never undo a room that was created successfully.
      await this.sendRoomCreatedMessage(member, hub, vc, textChannelId);

      log.info(`Created "${vc.name}" for ${member.user.username}`);
    } catch (err) {
      // Room creation failed after retries — do not fail silently. Notify the
      // member and raise exactly one owner alert so the outage is visible.
      log.error('Failed to create temp channel:', { error: String(err) });
      this.eventBus.emit('temp_channel.creation_failed', this.guild.id, {
        hubId: hub.id,
        hubChannelId: hub.hub_channel_id,
        memberId: member.id,
        error: String(err),
      });
      await this.notifyCreationFailure(member, hub, err);
      if (occurrenceId) {
        if (cleanupJobCommitted) {
          // The durable cleanup job owns the surviving external channels.
        } else if (cleanupPersistExhausted) {
          // Survivors exist but recording them failed even after retries.
          // Deliberately do NOTHING to the occurrence: `failed` is terminal
          // and the reconciler would never look at it again, while a claimed
          // row is still recoverable — a later attempt for the same key goes
          // through the stale-claim reclaim path, and the ids were logged
          // above for manual recovery in the worst case.
        } else if (!externalRoomExists && !activeRecordCommitted) {
          await releaseDiscordOccurrence(this.supabase, occurrenceId).catch(() => {});
        } else {
          // A room or durable active row may exist. Preserve the fence so a
          // retry cannot create a duplicate across an ambiguous commit window.
          await failDiscordOccurrence(this.supabase, occurrenceId, String(err)).catch(() => {});
        }
      }
    } finally {
      this.inFlightJoins.delete(joinKey);
    }
  }

  /**
   * Recover the crash window between Discord channel creation and the
   * active_temp_channels insert. The winning claim stores a deterministic room
   * identity before any Discord side effect. A stale duplicate first refreshes
   * the guild channel snapshot and adopts a matching survivor; only after
   * proving that none exists may it renew the claim through a database CAS.
   */
  private async recoverStaleCreationClaim(
    occurrence: DiscordOperationOccurrence,
    member: GuildMember,
    hub: HubConfig,
  ): Promise<'recovered' | 'reclaimed' | 'blocked'> {
    if (occurrence.status !== 'claimed') return 'blocked';
    const metadata = occurrence.result;
    if (
      metadata.recoveryKind !== 'temp_channel_create'
      || metadata.hubId !== hub.id
      || metadata.hubChannelId !== hub.hub_channel_id
      || metadata.categoryId !== hub.category_id
      || metadata.ownerId !== member.id
      || typeof metadata.channelName !== 'string'
    ) {
      return 'blocked';
    }
    const plannedChannelName = metadata.channelName;

    const claimedAt = Date.parse(occurrence.claimed_at);
    const staleBeforeMs = Date.now() - CREATION_CLAIM_LEASE_MS;
    if (!Number.isFinite(claimedAt) || claimedAt >= staleBeforeMs) return 'blocked';

    try {
      await this.guild.channels.fetch();
    } catch (error) {
      log.warn('Could not refresh Discord channels for stale temp-room recovery', {
        occurrenceId: occurrence.id,
        error: String(error),
      });
      return 'blocked';
    }

    // Durable ids beat name heuristics. When the crashed attempt persisted
    // createdChannelIds, resolve survivors BY ID: a text channel surviving
    // alone (voice deleted, cleanup writes all failed) is invisible to the
    // voice name-search below — recovery would reclaim the occurrence and
    // spawn a fresh room while the text channel stayed orphaned forever.
    // Delete lone non-voice survivors first; while any survivor resists
    // deletion the claim stays blocked rather than reclaimed.
    const createdChannelIds = Array.isArray(metadata.createdChannelIds)
      ? metadata.createdChannelIds.filter((value): value is string => typeof value === 'string')
      : [];
    if (createdChannelIds.length > 0) {
      const survivors = createdChannelIds
        .map((channelId) => this.guild.channels.cache.get(channelId))
        .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel));
      const hasVoiceSurvivor = survivors.some(
        (channel) => channel.type === ChannelType.GuildVoice,
      );
      if (!hasVoiceSurvivor && survivors.length > 0) {
        for (const survivor of survivors) {
          try {
            await survivor.delete('Removing orphaned temp-channel remnant before reclaim');
          } catch (deleteError) {
            log.warn('Orphaned temp-channel remnant resisted deletion; blocking reclaim', {
              occurrenceId: occurrence.id,
              channelId: survivor.id,
              error: String(deleteError),
            });
            return 'blocked';
          }
        }
      }
    }

    // The durable createdChannelIds are the AUTHORITATIVE room identity: a
    // survivor renamed or moved during the stale window would slip past the
    // name/category/timestamp heuristic, get reclaimed, and be recreated
    // while the known room orphans. The heuristic remains only for claims
    // that predate the id write.
    const voiceById = createdChannelIds
      .map((channelId) => this.guild.channels.cache.get(channelId))
      .find((channel): channel is VoiceChannel =>
        channel?.type === ChannelType.GuildVoice,
      );
    const voice = voiceById ?? [...this.guild.channels.cache.values()].find((candidate) => {
      if (candidate.type !== ChannelType.GuildVoice) return false;
      const channel = candidate as VoiceChannel;
      return channel.name === plannedChannelName
        && channel.parentId === hub.category_id
        && channel.createdTimestamp >= claimedAt - 5_000
        && channel.permissionOverwrites.cache
          .get(member.id)?.allow.has(PermissionFlagsBits.ManageChannels) === true;
    }) as VoiceChannel | undefined;

    if (voice) {
      const pairedTextName =
        typeof metadata.pairedTextName === 'string' ? metadata.pairedTextName : null;
      // Same durable-id preference as the voice member of the pair: a text
      // channel renamed or moved during the stale window must not be dropped
      // to text_channel_id null and orphaned outside every cleanup path.
      const pairedTextById = createdChannelIds
        .map((channelId) => this.guild.channels.cache.get(channelId))
        .find((channel): channel is TextChannel =>
          channel?.type === ChannelType.GuildText,
        );
      const pairedText = pairedTextById ?? (pairedTextName
        ? [...this.guild.channels.cache.values()].find((candidate) => {
            if (candidate.type !== ChannelType.GuildText) return false;
            const channel = candidate as TextChannel;
            return channel.name === pairedTextName
              && channel.parentId === hub.category_id
              && channel.createdTimestamp >= claimedAt - 5_000
              && channel.permissionOverwrites.cache
                .get(member.id)?.allow.has(PermissionFlagsBits.ViewChannel) === true
              && channel.permissionOverwrites.cache
                .get(member.id)?.allow.has(PermissionFlagsBits.SendMessages) === true
              && channel.permissionOverwrites.cache
                .get(member.id)?.allow.has(PermissionFlagsBits.ManageMessages) === true
              && channel.permissionOverwrites.cache
                .get(this.guild.id)?.deny.has(PermissionFlagsBits.ViewChannel) === true;
          }) as TextChannel | undefined
        : undefined);
      const recovered: ActiveTempChannel = {
        channel_id: voice.id,
        text_channel_id: pairedText?.id ?? null,
        guild_id: this.guild.id,
        hub_id: hub.id,
        owner_id: member.id,
        creation_occurrence_id: occurrence.id,
      };
      const { error: insertError } = await this.supabase
        .from('active_temp_channels')
        .insert(recovered);
      if (insertError) {
        const { data: concurrent, error: readError } = await this.supabase
          .from('active_temp_channels')
          .select('*')
          .eq('creation_occurrence_id', occurrence.id)
          .maybeSingle();
        if (readError || !concurrent?.channel_id || concurrent.owner_id !== member.id) {
          log.error('Could not adopt recovered temp room', {
            occurrenceId: occurrence.id,
            channelId: voice.id,
            error: insertError.message,
          });
          return 'blocked';
        }
        this.activeChannels.set(concurrent.channel_id, concurrent as ActiveTempChannel);
        const concurrentChannel = this.guild.channels.cache.get(concurrent.channel_id);
        if (concurrentChannel?.type === ChannelType.GuildVoice) {
          await member.voice.setChannel(concurrentChannel as VoiceChannel);
        }
        return 'recovered';
      }

      this.activeChannels.set(voice.id, recovered);
      await completeDiscordOccurrence(
        this.supabase,
        occurrence.id,
        voice.id,
        { textChannelId: recovered.text_channel_id, recoveredAfterCrash: true },
      ).catch((error) => {
        log.error('Failed to complete recovered temp-room occurrence', {
          occurrenceId: occurrence.id,
          error: String(error),
        });
      });
      await member.voice.setChannel(voice);
      return 'recovered';
    }

    const reclaimed = await reclaimStaleDiscordOccurrence(
      this.supabase,
      occurrence,
      new Date(staleBeforeMs).toISOString(),
    );
    return reclaimed ? 'reclaimed' : 'blocked';
  }

  /**
   * Run an operation with a bounded retry so a single transient failure does not
   * drop the whole action. Returns the first successful result or rethrows the
   * last error after all attempts are exhausted.
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const maxAttempts = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          log.warn(`${label} attempt ${attempt} failed, retrying`, { error: String(err) });
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Surface a room-creation outage: DM the member and raise one owner alert.
   * (The temp_channels.creation_failed audit event is emitted by the caller's
   * platform-event pipeline; the alerts row here drives the dashboard badge and
   * the owner alert channel.)
   */
  private async notifyCreationFailure(
    member: GuildMember,
    hub: HubConfig,
    err: unknown,
  ): Promise<void> {
    // Member notice (best effort — DMs may be closed).
    try {
      await member.send(
        "⚠️ I couldn't create your temporary voice channel just now. Please try again in a moment, or let a server admin know if it keeps happening.",
      );
    } catch {
      // Member has DMs disabled — nothing more we can surface to them here.
    }

    // Owner alert — alerts row + alert-channel notice (X1/M2).
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'temp_channel_creation_failed',
        severity: 'warning',
        title: 'Temporary voice channel could not be created',
        message:
          `A member tried to create a temporary voice channel from hub <#${hub.hub_channel_id}> ` +
          `but creation failed: ${String(err)}. Check my Manage Channels permission and the hub's category.`,
        metadata: { hub_id: hub.id, hub_channel_id: hub.hub_channel_id, member_id: member.id },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.error('Failed to write temp-channel creation alert:', { error: String(alertErr) });
    }
  }

  /**
   * Post the branded "room created" welcome into the new room. Prefers the paired
   * text channel; otherwise the voice channel's built-in text chat. Best-effort:
   * a send failure (missing perms, no text surface, etc.) is logged and swallowed
   * so it can never roll back a room that was created successfully. Mentions are
   * disabled so a template can't be turned into an @everyone ping.
   */
  private async sendRoomCreatedMessage(
    member: GuildMember,
    hub: HubConfig,
    vc: VoiceChannel,
    textChannelId: string | null,
  ): Promise<void> {
    try {
      const content = renderTempChannelTemplate(hub, 'room_created', {
        'owner-name': member.displayName,
        owner: member.displayName,
        username: member.displayName,
        user: member.displayName,
        tag: member.user.username,
        'room-name': vc.name,
        server: this.guild.name,
      });
      if (!content.trim()) return;

      // Prefer the paired text channel; fall back to the voice channel's own
      // text chat. Duck-type `.send` (via unknown) so this works for any
      // sendable channel without a wide discord.js type guard.
      const target: unknown = textChannelId
        ? this.guild.channels.cache.get(textChannelId)
        : vc;
      const sender = target as { send?: (payload: unknown) => Promise<unknown> } | null | undefined;
      if (sender && typeof sender.send === 'function') {
        await sender.send({ content, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      log.warn('Failed to post room-created message:', { error: String(err) });
    }
  }

  /**
   * Handle a user leaving a temp voice channel — delete if empty (after keep-alive).
   */
  async handleLeaveTemp(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    const vc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
    if (!vc) {
      // Channel already gone — clean up the stale record (reconciliation).
      await this.removeChannel(channelId);
      this.eventBus.emit('temp_channel.orphan_reconciled', this.guild.id, {
        channelId,
        ownerId: active.owner_id,
      });
      return;
    }

    if (vc.members.filter((m) => !m.user.bot).size > 0) {
      // Still people in the channel, cancel any pending delete
      const timer = this.keepAliveTimers.get(channelId);
      if (timer) {
        clearTimeout(timer);
        this.keepAliveTimers.delete(channelId);
      }
      return;
    }

    // Channel empty — start empty-room grace countdown. The catalog control is
    // empty-grace-seconds (seconds); keep_alive_minutes is a compatibility
    // fallback for any hub not yet backfilled to the seconds column.
    const hub = this.getHubForChannel(channelId);
    const graceSeconds = hub?.empty_grace_seconds ?? ((hub?.keep_alive_minutes ?? 1) * 60);
    const keepAliveMs = graceSeconds * 1000;

    // Cancel any existing timer
    const existing = this.keepAliveTimers.get(channelId);
    if (existing) clearTimeout(existing);

    this.scheduleEmptyCleanup(channelId, keepAliveMs);
  }

  private scheduleEmptyCleanup(channelId: string, delayMs: number, retryAttempt = 0): void {
    const existing = this.keepAliveTimers.get(channelId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      if (this.keepAliveTimers.get(channelId) === timer) {
        this.keepAliveTimers.delete(channelId);
      }
      try {
        if (!this.activeChannels.has(channelId)) return;
        const freshVc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
        if (freshVc && freshVc.members.filter((m) => !m.user.bot).size > 0) {
          return;
        }
        await this.deleteChannel(channelId);
      } catch (err) {
        log.error('Keep-alive cleanup error:', { error: String(err) });
        const nextAttempt = retryAttempt + 1;
        if (this.activeChannels.has(channelId) && nextAttempt <= CLEANUP_RETRY_LIMIT) {
          const retryDelay = Math.min(
            CLEANUP_RETRY_BASE_MS * (2 ** (nextAttempt - 1)),
            CLEANUP_RETRY_MAX_MS,
          );
          this.scheduleEmptyCleanup(channelId, retryDelay, nextAttempt);
        }
      }
    }, delayMs);

    this.keepAliveTimers.set(channelId, timer);
  }

  /**
   * Delete a temp channel and its paired text channel.
   */
  async deleteChannel(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    const ownerId = active.owner_id;

    try {
      const vc = this.guild.channels.cache.get(channelId);
      if (vc) await vc.delete('Temp channel empty');
    } catch {
      // Channel may already be deleted
    }

    if (active.text_channel_id) {
      try {
        const tc = this.guild.channels.cache.get(active.text_channel_id);
        if (tc) await tc.delete('Temp text channel cleanup');
      } catch {
        // Ignore
      }
    }

    await this.removeChannel(channelId);
    this.eventBus.emit('temp_channel.deleted', this.guild.id, {
      channelId,
      ownerId,
      reason: 'empty',
    });
    log.info(`Deleted temp channel ${channelId}`);
  }

  /**
   * Transfer ownership of a temp channel.
   */
  async transferOwnership(channelId: string, newOwnerId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    const oldOwnerId = active.owner_id;
    const oldOccurrenceId = active.creation_occurrence_id ?? null;

    // Commit the durable owner and creation-fence transition in one database
    // transaction before changing Discord. A partial database failure must
    // never leave the old owner recorded after their fence was retired.
    const { data: transferred, error: transferError } = await this.supabase.rpc(
      'transfer_temp_channel_ownership',
      {
        p_guild_id: this.guild.id,
        p_channel_id: channelId,
        p_new_owner_id: newOwnerId,
        p_expected_owner_id: oldOwnerId,
        p_expected_occurrence_id: oldOccurrenceId,
      },
    );
    if (transferError) {
      throw new Error(`Failed to persist temp-channel ownership transfer: ${transferError.message}`);
    }
    if (transferred !== true) {
      throw new Error('Failed to persist temp-channel ownership transfer: active ownership changed');
    }

    active.owner_id = newOwnerId;
    active.creation_occurrence_id = null;

    // Update permissions only after the durable owner is authoritative.
    const vc = this.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
    if (vc) {
      try {
        // Remove old owner overwrite
        await vc.permissionOverwrites.delete(oldOwnerId).catch((e: unknown) => { /* channel/user may not exist */; });
        // Add new owner overwrite
        await vc.permissionOverwrites.create(newOwnerId, {
          ManageChannels: true,
          MoveMembers: true,
          MuteMembers: true,
          DeafenMembers: true,
        });
      } catch (err) {
        log.error('Failed to update permissions:', { error: String(err) });
      }
    }

    this.eventBus.emit('temp_channel.claimed', this.guild.id, {
      channelId,
      previousOwnerId: oldOwnerId,
      newOwnerId,
    });
  }

  /**
   * Reload hub config from DB (e.g., after dashboard update).
   */
  async reloadHubs(): Promise<void> {
    this.hubs.clear();
    const { data: hubs } = await this.supabase
      .from('temp_channel_hubs')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (hubs) {
      for (const hub of hubs) {
        this.hubs.set(hub.hub_channel_id, hub as HubConfig);
      }
    }
  }

  private async removeChannel(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (!active) return;

    // Retire the durable active row and its creation fence in one transaction.
    // Keep the in-memory record and timer intact on failure so startup/orphan
    // reconciliation can retry instead of permanently wedging this member+hub.
    const { data: retired, error: retireError } = await this.supabase.rpc(
      'retire_temp_channel',
      {
        p_guild_id: this.guild.id,
        p_channel_id: channelId,
        p_expected_occurrence_id: active.creation_occurrence_id ?? null,
      },
    );
    if (retireError) {
      throw new Error(`Failed to retire temp channel: ${retireError.message}`);
    }
    if (retired !== true) {
      throw new Error('Failed to retire temp channel: active channel changed');
    }

    this.activeChannels.delete(channelId);
    const timer = this.keepAliveTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.keepAliveTimers.delete(channelId);
    }
  }

  private async cleanupOrphans(): Promise<void> {
    // Remove DB records for channels that no longer exist in Discord
    for (const [channelId, active] of this.activeChannels) {
      const vc = this.guild.channels.cache.get(channelId);
      if (!vc) {
        await this.removeChannel(channelId);
        // [community-temporary-channels] Append-only audit row per reconciled
        // orphan. Written directly because start() runs during guild init
        // BEFORE the per-guild AuditService attaches its event listener, so the
        // temp_channel.orphan_reconciled emit below is never mapped to an
        // audit_logs row on this startup path.
        await writeAuditLog(this.supabase, {
          guildId: this.guild.id,
          actorType: 'system',
          actorId: 'system',
          action: 'temp_channel.orphan_reconciled',
          category: 'temp_channels',
          targetType: 'channel',
          targetId: channelId,
          details: { ownerId: active.owner_id, reason: 'startup_reconciliation' },
        });
        this.eventBus.emit('temp_channel.orphan_reconciled', this.guild.id, {
          channelId,
          ownerId: active.owner_id,
        });
      }
    }
  }

  async reconcilePendingChannelCleanup(): Promise<number> {
    const { data, error } = await this.supabase
      .from('discord_operation_occurrences')
      .select('id,result')
      .eq('guild_id', this.guild.id)
      .eq('operation_kind', 'temp_channel')
      .eq('status', 'claimed')
      .contains('result', { channelCleanupPending: true })
      // Oldest-touched first: failed rows are touched to the back below, so a
      // blocked cohort (channels the bot cannot delete) rotates instead of
      // occupying all 100 slots on every pass and starving newer jobs.
      .order('updated_at', { ascending: true })
      .limit(100);
    if (error) {
      throw new Error(`Unable to load temp-channel cleanup jobs: ${error.message}`);
    }

    let reconciled = 0;
    for (const row of data ?? []) {
      if (typeof row.id !== 'string') continue;
      const result =
        row.result && typeof row.result === 'object' && !Array.isArray(row.result)
          ? row.result as Record<string, unknown>
          : {};
      const channelIds = Array.isArray(result.channelIds)
        ? result.channelIds.filter((value): value is string => typeof value === 'string')
        : [];
      if (channelIds.length === 0) continue;

      let allConfirmedMissing = true;
      for (const channelId of channelIds) {
        let channel = this.guild.channels.cache.get(channelId);
        if (!channel) {
          try {
            channel = await this.guild.channels.fetch(channelId) ?? undefined;
          } catch (fetchError) {
            const code =
              typeof fetchError === 'object' && fetchError !== null && 'code' in fetchError
                ? Number((fetchError as { code: unknown }).code)
                : Number.NaN;
            if (code === RESTJSONErrorCodes.UnknownChannel) continue;
            allConfirmedMissing = false;
            log.warn('Could not verify temp-channel cleanup target', {
              channelId,
              error: String(fetchError),
            });
            continue;
          }
        }
        if (!channel) continue;
        try {
          await channel.delete('Retrying cleanup after failed temp-channel creation');
        } catch (deleteError) {
          const code =
            typeof deleteError === 'object' && deleteError !== null && 'code' in deleteError
              ? Number((deleteError as { code: unknown }).code)
              : Number.NaN;
          if (code === RESTJSONErrorCodes.UnknownChannel) continue;
          allConfirmedMissing = false;
          log.warn('Temp-channel cleanup will be retried', {
            channelId,
            error: String(deleteError),
          });
        }
      }

      if (allConfirmedMissing) {
        await releaseDiscordOccurrence(this.supabase, row.id);
        reconciled++;
      } else {
        // Best-effort rotation touch, conditional on the row staying claimed —
        // bookkeeping must never turn a blocked job into a lost one.
        const { error: touchError } = await this.supabase
          .from('discord_operation_occurrences')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'claimed');
        if (touchError) {
          log.warn('Could not rotate blocked temp-channel cleanup job', {
            occurrenceId: row.id,
            error: touchError.message,
          });
        }
      }
    }
    return reconciled;
  }

  stop(): void {
    if (this.pendingChannelCleanupTimer) {
      clearInterval(this.pendingChannelCleanupTimer);
      this.pendingChannelCleanupTimer = null;
    }
    for (const timer of this.keepAliveTimers.values()) {
      clearTimeout(timer);
    }
    this.keepAliveTimers.clear();
  }
}
