/**
 * Integration test: bot_action_queue lane segregation
 * (20260710020000_bot_action_queue_lanes).
 *
 * The queue carries BOTH real-commerce fulfillment (fulfill_*,
 * deliver_receipt, revoke_roles — paying customers' money) and game-economy /
 * infra jobs. Lane classification is enforced authoritatively by a BEFORE
 * INSERT trigger so no producer — bot, dashboard, DLQ retry, or future code —
 * can misroute a commerce action into the game lane. These tests exercise the
 * real trigger, ordering, and dedupe index against the CI-local Supabase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-lanes-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Lanes Test Guild',
    owner_discord_id: '123456789',
  });
});

afterAll(async () => {
  await supa.from('alerts').delete().eq('guild_id', GUILD_ID);
  await supa.from('action_queue_dlq').delete().eq('guild_id', GUILD_ID);
  await supa.from('bot_action_queue').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('lane stamp trigger on bot_action_queue', () => {
  it.each([
    ['fulfill_purchase', 'commerce'],
    ['fulfill_subscription', 'commerce'],
    ['fulfill_cancellation', 'commerce'],
    ['fulfill_suspension', 'commerce'],
    ['fulfill_giveaway_prize', 'commerce'],
    ['deliver_receipt', 'commerce'],
    ['revoke_roles', 'commerce'],
    ['market_item_reconcile', 'game'],
    ['config_reload', 'game'],
    ['bulk_send_dm', 'game'],
  ])('stamps %s into the %s lane when no lane is supplied', async (action, lane) => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({ guild_id: GUILD_ID, action, payload: {}, status: 'pending' })
      .select('lane')
      .single();

    expect(error).toBeNull();
    expect(data!.lane).toBe(lane);
  });

  it('overrides a client-supplied lane — commerce actions cannot be demoted', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'deliver_receipt',
        payload: {},
        status: 'pending',
        lane: 'game', // hostile/buggy producer tries to bury a receipt delivery
      })
      .select('lane')
      .single();

    expect(error).toBeNull();
    expect(data!.lane).toBe('commerce');
  });

  it('overrides a client-supplied lane — game actions cannot jump the queue', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'market_item_reconcile',
        payload: {},
        status: 'pending',
        lane: 'commerce', // game-economy job tries to ride the priority lane
      })
      .select('lane')
      .single();

    expect(error).toBeNull();
    expect(data!.lane).toBe('game');
  });

  it('ORDER BY lane, created_at surfaces a NEWER commerce row ahead of an older game flood', async () => {
    // This is the exact query shape the bot sweep uses. The ordering must
    // happen in the database: with a flood deeper than the sweep's batch
    // LIMIT, an in-memory sort could never see the commerce row at all.
    const floodGuild = `${GUILD_ID}-flood`;
    await supa.from('guild').insert({
      id: floodGuild,
      name: 'Lanes Flood Guild',
      owner_discord_id: '123456789',
    });
    try {
      const gameFlood = Array.from({ length: 20 }, (_, i) => ({
        guild_id: floodGuild,
        action: 'config_reload',
        payload: { i },
        status: 'pending',
      }));
      await supa.from('bot_action_queue').insert(gameFlood);
      // Inserted last → newest created_at, yet must be returned first.
      await supa.from('bot_action_queue').insert({
        guild_id: floodGuild,
        action: 'fulfill_purchase',
        payload: {},
        status: 'pending',
      });

      const { data, error } = await supa
        .from('bot_action_queue')
        .select('action, lane')
        .eq('guild_id', floodGuild)
        .eq('status', 'pending')
        .order('lane', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(5);

      expect(error).toBeNull();
      expect(data![0]!.action).toBe('fulfill_purchase');
      expect(data![0]!.lane).toBe('commerce');
    } finally {
      await supa.from('bot_action_queue').delete().eq('guild_id', floodGuild);
      await supa.from('guild').delete().eq('id', floodGuild);
    }
  });
});

describe('lane stamp trigger on action_queue_dlq', () => {
  it('stamps the lane on dead-lettered rows from the action type', async () => {
    const { data, error } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        action: 'deliver_receipt',
        payload: {},
        error_message: 'test dead letter',
        retry_count: 3,
      })
      .select('lane')
      .single();

    expect(error).toBeNull();
    expect(data!.lane).toBe('commerce');

    const { data: gameRow } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        action: 'market_item_reconcile',
        payload: {},
        error_message: 'test dead letter',
        retry_count: 5,
      })
      .select('lane')
      .single();

    expect(gameRow!.lane).toBe('game');
  });
});

describe('per-lane depth alert dedupe (uniq_alerts_unresolved_action_queue_depth)', () => {
  it('allows at most one unresolved depth alert per guild per lane', async () => {
    const alertRow = {
      guild_id: GUILD_ID,
      alert_type: 'action_queue_depth_commerce',
      severity: 'critical',
      title: 'Commerce action queue backing up — 11 pending',
      message: 'test',
      metadata: { lane: 'commerce', depth: 11, threshold: 10 },
    };

    const first = await supa.from('alerts').insert(alertRow);
    expect(first.error).toBeNull();

    // Racing duplicate loses with 23505 — the atomic dedupe the bot relies on.
    const dup = await supa.from('alerts').insert(alertRow);
    expect(dup.error).not.toBeNull();
    expect(dup.error!.code).toBe('23505');

    // The game lane is deduped independently of the commerce lane.
    const gameAlert = await supa.from('alerts').insert({
      ...alertRow,
      alert_type: 'action_queue_depth_game',
      severity: 'warning',
      title: 'Game action queue backing up — 101 pending',
      metadata: { lane: 'game', depth: 101, threshold: 100 },
    });
    expect(gameAlert.error).toBeNull();

    // Resolving frees the slot for the next incident.
    const { error: resolveErr } = await supa
      .from('alerts')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('guild_id', GUILD_ID)
      .eq('alert_type', 'action_queue_depth_commerce')
      .eq('resolved', false);
    expect(resolveErr).toBeNull();

    const again = await supa.from('alerts').insert(alertRow);
    expect(again.error).toBeNull();
  });
});

describe('lane classification function', () => {
  it('is callable by service_role and matches the TS mirror', async () => {
    const { data, error } = await supa.rpc('bot_action_queue_lane_for_action', {
      p_action: 'deliver_receipt',
    });
    expect(error).toBeNull();
    expect(data).toBe('commerce');

    const { data: game } = await supa.rpc('bot_action_queue_lane_for_action', {
      p_action: 'anything_unknown',
    });
    expect(game).toBe('game');
  });
});
