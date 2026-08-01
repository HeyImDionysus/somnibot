import pathlib

# ── T5: all-rate-limited finalize keeps the TRUE condition result ──────────
p = pathlib.Path('packages/bot/src/features/automations/automation-engine.ts')
s = p.read_text(encoding='utf-8')
old = """        // Every target is rate-limited: the same outcome the old
        // pre-decision filter produced — nothing runs.
        await this.executionLogger.finalize(claimRowId, {
          automationId: automation.id,
          guildId: this.guild.id,
          triggeredBy: userId,
          triggerEvent: event.type,
          conditionsPassed: false,
          actionsExecuted: 0,
          actionsFailed: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        });
        return;"""
new = """        // Every target is rate-limited: nothing runs, but the conditions DID
        // match — history must say why nothing happened, not fabricate a
        // failed evaluation (approved holds record the same truth when
        // release-time limits empty their target set).
        await this.executionLogger.finalize(claimRowId, {
          automationId: automation.id,
          guildId: this.guild.id,
          triggeredBy: userId,
          triggerEvent: event.type,
          conditionsPassed: true,
          actionsExecuted: 0,
          actionsFailed: 0,
          errors: ['Every matched member was rate-limited; no action ran'],
          durationMs: Date.now() - startTime,
        });
        return;"""
assert s.count(old) == 1
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

# ── T2: paired text channel resolved by durable id first ───────────────────
p = pathlib.Path('packages/bot/src/features/temp-channels/temp-channel-manager.ts')
s = p.read_text(encoding='utf-8')
old = """      const pairedTextName =
        typeof metadata.pairedTextName === 'string' ? metadata.pairedTextName : null;
      const pairedText = pairedTextName
        ? [...this.guild.channels.cache.values()].find((candidate) => {"""
new = """      const pairedTextName =
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
        ? [...this.guild.channels.cache.values()].find((candidate) => {"""
assert s.count(old) == 1
s = s.replace(old, new)
# Close the moved parenthesis: the original expression ended `: null;` after
# the find — locate its tail.
old = """              && channel.permissionOverwrites.cache
                .get(member.id)?.allow.has(PermissionFlagsBits.ViewChannel) === true
              && channel.permissionOverwrites.cache"""
idx = s.find(old)
assert idx != -1
tail = s.find(': null;', idx)
assert tail != -1
old_tail = s[idx:tail + len(': null;')]
# The original ternary was `pairedTextName ? find(...) : null;` — now wrapped
# as `pairedTextById ?? (pairedTextName ? find(...) : null);`
new_tail = old_tail[:-len(': null;')] + ': null);'
s = s.replace(old_tail, new_tail)
p.write_text(s, encoding='utf-8')

# ── T3: ambiguous→persisted resumes normal bookkeeping ─────────────────────
p = pathlib.Path('packages/bot/src/features/stats-channels/stats-manager.ts')
s = p.read_text(encoding='utf-8')
old = """          const ambiguousId = this.ambiguousChannels.get(config.id);
          if (ambiguousId) {
            // Resolve the ambiguous channel before ever creating another.
            const retry = await this.persistChannelIdentity(config, ambiguousId);
            if (retry.outcome === 'persisted') {
              this.ambiguousChannels.delete(config.id);
            } else if (retry.outcome === 'lost_race') {"""
new = """          const ambiguousId = this.ambiguousChannels.get(config.id);
          if (ambiguousId) {
            // Resolve the ambiguous channel before ever creating another.
            const retry = await this.persistChannelIdentity(config, ambiguousId);
            if (retry.outcome === 'persisted') {
              // Fall THROUGH to the normal success bookkeeping (value write,
              // event, resolveUpdateAlerts) — an unconditional continue left
              // the update-failed alert standing forever once last_value
              // matched and later ticks took the unchanged-value shortcut.
              this.ambiguousChannels.delete(config.id);
              channelId = ambiguousId;
              const resolvedChannel =
                this.guild.channels.cache.get(ambiguousId) as VoiceChannel | undefined;
              if (resolvedChannel) {
                await resolvedChannel.setName(newName).catch((renameError) => {
                  log.warn('Recovered stats counter could not be renamed this tick:', {
                    statsChannelId: config.id,
                    error: String(renameError),
                  });
                });
              }
            } else if (retry.outcome === 'lost_race') {"""
assert s.count(old) == 1
s = s.replace(old, new)
old = """            // Still ambiguous, or just resolved: never create this tick.
            continue;
          }
          // Create the voice channel if it doesn't exist yet"""
new = """            if (!channelId) {
              // Still ambiguous or disposed: never create this tick.
              continue;
            }
          }
          if (!channelId) {
          // Create the voice channel if it doesn't exist yet"""
assert s.count(old) == 1
s = s.replace(old, new)
old = """          channelId = channel.id;
          created = true;
        }
"""
new = """          channelId = channel.id;
          created = true;
          }
        }
"""
assert s.count(old) == 1
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

# ── T4: lease-expiry recovery finalizes the linked execution ───────────────
p = pathlib.Path('packages/supabase/migrations/20260731032000_exact_head_review_reliability_followup.sql')
s = p.read_text(encoding='utf-8')
old = """DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.automation_mass_action_holds
     SET status = 'failed',
         completed_at = pg_catalog.now(),
         last_error =
           'Execution lease expired after work started. Some member actions may have completed; inspect the audit log before retrying manually.',
         execution_owner_token = NULL,
         execution_lease_expires_at = NULL
   WHERE guild_id = p_guild_id
     AND status = 'executing'
     AND execution_lease_expires_at IS NOT NULL
     AND execution_lease_expires_at < pg_catalog.now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;"""
new = """DECLARE
  affected INTEGER;
BEGIN
  -- Round 15/20: fail the expired holds AND finalize their linked execution
  -- rows in the SAME statement. The engine only finalizes an execution after
  -- every held action completes, so a crash mid-run left the pre-action
  -- defaults and history read 'Conditions not met' for an approved hold that
  -- may already have changed members. The finalize is conditional on those
  -- exact defaults, so an execution finalized before the lease expired is
  -- preserved untouched.
  WITH failed_holds AS (
    UPDATE public.automation_mass_action_holds
       SET status = 'failed',
           completed_at = pg_catalog.now(),
           last_error =
             'Execution lease expired after work started. Some member actions may have completed; inspect the audit log before retrying manually.',
           execution_owner_token = NULL,
           execution_lease_expires_at = NULL
     WHERE guild_id = p_guild_id
       AND status = 'executing'
       AND execution_lease_expires_at IS NOT NULL
       AND execution_lease_expires_at < pg_catalog.now()
    RETURNING id, execution_id
  ), finalized AS (
    UPDATE public.automation_executions AS execution
       SET conditions_passed = TRUE,
           errors =
             '["Execution lease expired after work started; recovery failed the hold. Some member actions may have completed."]'::jsonb
      FROM failed_holds
     WHERE execution.id = failed_holds.execution_id
       AND execution.conditions_passed = FALSE
       AND execution.actions_executed = 0
       AND execution.actions_failed = 0
  )
  SELECT pg_catalog.count(*) INTO affected FROM failed_holds;
  RETURN affected;
END;
$$;"""
assert s.count(old) == 1
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

# ── T1: fallback downloads use delivery-aware selection ────────────────────
p = pathlib.Path('packages/dashboard/src/app/api/downloads/[productId]/[fileId]/route.ts')
s = p.read_text(encoding='utf-8')
old = """import { isEntitlementAccessLive } from '@somnibot/shared';"""
new = """import { isEntitlementAccessLive } from '@somnibot/shared';
import { selectDownloadEntitlement } from '@/lib/portal/select-entitlement';"""
assert s.count(old) == 1
s = s.replace(old, new)
old = """  const liveEntitlements = entitlements
    ?.filter((entitlement) => isEntitlementAccessLive(entitlement)) ?? [];
  const liveEntitlement = signedEntitlementId
    ? liveEntitlements.find((entitlement) => entitlement.id === signedEntitlementId)
    : liveEntitlements.sort((left, right) =>
      String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')),
    )[0];
  if (!liveEntitlement) {
    return NextResponse.json({ error: 'No active entitlement for this product' }, { status: 403 });
  }"""
new = """  const liveEntitlements = entitlements
    ?.filter((entitlement) => isEntitlementAccessLive(entitlement)) ?? [];
  let liveEntitlement: (typeof liveEntitlements)[number] | undefined;
  if (signedEntitlementId) {
    liveEntitlement = liveEntitlements.find(
      (entitlement) => entitlement.id === signedEntitlementId,
    );
  } else {
    // The fallback paths (portal-token API clients, legacy no-eid links) use
    // the SAME delivery-aware ranking as link minting: an undelivered repeat
    // purchase must be able to claim its evidence before a delivered newer
    // order is re-served — otherwise every fallback download records against
    // the newest order and the older one is flagged forever.
    const candidateOrderIds = [...new Set(
      liveEntitlements
        .map((candidate) => candidate.order_id)
        .filter((id): id is string => typeof id === 'string'),
    )];
    const deliveredOrderIds = new Set<string>();
    if (candidateOrderIds.length > 0) {
      const { data: deliveries, error: deliveriesError } = await supabase
        .from('commerce_download_deliveries')
        .select('order_id')
        .in('order_id', candidateOrderIds);
      if (deliveriesError) {
        return serviceUnavailable('Downloads delivery history', deliveriesError);
      }
      for (const delivery of deliveries ?? []) {
        if (typeof delivery.order_id === 'string') {
          deliveredOrderIds.add(delivery.order_id);
        }
      }
    }
    liveEntitlement = selectDownloadEntitlement(liveEntitlements, deliveredOrderIds);
  }
  if (!liveEntitlement) {
    return NextResponse.json({ error: 'No active entitlement for this product' }, { status: 403 });
  }"""
assert s.count(old) == 1
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')
print('round-20 repairs applied')
