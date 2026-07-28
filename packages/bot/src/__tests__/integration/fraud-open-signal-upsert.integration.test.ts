/**
 * Integration tests for `fraud_upsert_open_signal`.
 *
 * The backing uniqueness rule is a partial index (`WHERE status = 'open'`),
 * which PostgREST's normal column-only upsert cannot target. These tests use
 * the real RPC and schema to prove idempotence, monotonic severity, concurrent
 * safety, preserved resolved history, and the service-role-only boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getAnonTestClient,
  getAuthenticatedTestClient,
  requireSupabase,
} from './helpers.js';

let service!: SupabaseClient;
let anon!: SupabaseClient;
let authenticated!: SupabaseClient;

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const guildId = `test-fraud-upsert-${runId}`;

beforeAll(async () => {
  service = await requireSupabase();
  anon = getAnonTestClient();
  authenticated = getAuthenticatedTestClient();

  const seeded = await service.from('guild').insert({
    id: guildId,
    name: 'Fraud open-signal upsert integration test',
    owner_discord_id: '111222333444555666',
  });
  if (seeded.error) throw new Error(`Guild seed failed: ${seeded.error.message}`);
});

beforeEach(async () => {
  const cleared = await service.from('fraud_signals').delete().eq('guild_id', guildId);
  if (cleared.error) throw new Error(`Signal cleanup failed: ${cleared.error.message}`);
});

afterAll(async () => {
  if (service) {
    await service.from('fraud_signals').delete().eq('guild_id', guildId);
    await service.from('guild').delete().eq('id', guildId);
  }
});

function upsertSignal(
  client: SupabaseClient,
  overrides: Partial<{
    signalType: string;
    severity: string;
    entityId: string;
    discordId: string | null;
    description: string;
    evidence: Record<string, unknown>;
    autoAction: string | null;
  }> = {},
) {
  return client.rpc('fraud_upsert_open_signal', {
    p_guild_id: guildId,
    p_signal_type: overrides.signalType ?? 'device_abuse',
    p_severity: overrides.severity ?? 'high',
    p_entity_type: 'license_key',
    p_entity_id: overrides.entityId ?? 'key-1',
    p_discord_id: overrides.discordId === undefined ? 'discord-1' : overrides.discordId,
    p_description: overrides.description ?? '10 distinct devices in seven days',
    p_evidence: overrides.evidence ?? { devices_in_window: 10 },
    p_auto_action: overrides.autoAction ?? null,
  });
}

async function rowsFor(entityId = 'key-1') {
  const rows = await service.from('fraud_signals')
    .select('id,status,severity,discord_id,description,evidence,created_at,updated_at,last_observed_at')
    .eq('guild_id', guildId)
    .eq('signal_type', 'device_abuse')
    .eq('entity_type', 'license_key')
    .eq('entity_id', entityId)
    .order('created_at');
  if (rows.error) throw new Error(`Signal read failed: ${rows.error.message}`);
  return rows.data;
}

describe('fraud_upsert_open_signal', () => {
  it('refreshes one open row and never downgrades its severity or strongest evidence', async () => {
    const first = await upsertSignal(service, {
      severity: 'high',
      description: '10 devices',
      evidence: { devices_in_window: 10 },
    });
    expect(first.error).toBeNull();
    const firstRow = (await rowsFor())[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const sameSeverityRefresh = await upsertSignal(service, {
      severity: 'high',
      description: '11 devices',
      evidence: { devices_in_window: 11 },
    });
    expect(sameSeverityRefresh.error).toBeNull();
    expect(sameSeverityRefresh.data).toBe(first.data);
    const sameSeverityRow = (await rowsFor())[0]!;
    expect(sameSeverityRow).toMatchObject({
      severity: 'high',
      description: '11 devices',
      evidence: { devices_in_window: 11 },
    });
    expect(new Date(sameSeverityRow.last_observed_at).getTime())
      .toBeGreaterThan(new Date(firstRow.last_observed_at).getTime());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const escalated = await upsertSignal(service, {
      severity: 'critical',
      description: '20 devices',
      evidence: { devices_in_window: 20 },
    });
    expect(escalated.error).toBeNull();
    expect(escalated.data).toBe(first.data);
    const escalatedRow = (await rowsFor())[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const staleWeakerObservation = await upsertSignal(service, {
      severity: 'high',
      description: '12 devices (stale observer)',
      evidence: { devices_in_window: 12 },
    });
    expect(staleWeakerObservation.error).toBeNull();
    expect(staleWeakerObservation.data).toBe(first.data);

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.data,
      status: 'open',
      severity: 'critical',
      description: '20 devices',
      evidence: { devices_in_window: 20 },
    });
    expect(new Date(rows[0]!.updated_at).getTime())
      .toBeGreaterThan(new Date(firstRow.updated_at).getTime());
    expect(rows[0]!.last_observed_at).toBe(escalatedRow.last_observed_at);
    expect(new Date(rows[0]!.updated_at).getTime())
      .toBeGreaterThan(new Date(escalatedRow.updated_at).getTime());
  });

  it('serializes concurrent observations into one deterministic critical row', async () => {
    const observations = Array.from({ length: 12 }, (_, index) =>
      upsertSignal(service, {
        severity: index === 7 ? 'critical' : 'high',
        description: index === 7 ? 'critical observation' : `high observation ${index}`,
        evidence: { observation: index },
      }),
    );

    const results = await Promise.all(observations);

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(new Set(results.map((result) => result.data)).size).toBe(1);
    expect(await rowsFor()).toEqual([
      expect.objectContaining({
        status: 'open',
        severity: 'critical',
        description: 'critical observation',
        evidence: { observation: 7 },
      }),
    ]);
  });

  it('creates a new open row after an operator closes the prior history row', async () => {
    const original = await upsertSignal(service);
    expect(original.error).toBeNull();
    const closed = await service.from('fraud_signals')
      .update({ status: 'confirmed', resolution_note: 'operator confirmed' })
      .eq('id', original.data);
    expect(closed.error).toBeNull();

    const reopened = await upsertSignal(service, {
      description: 'new observation after closure',
      evidence: { devices_in_window: 11 },
    });

    expect(reopened.error).toBeNull();
    expect(reopened.data).not.toBe(original.data);
    expect(await rowsFor()).toEqual([
      expect.objectContaining({
        id: original.data,
        status: 'confirmed',
        description: '10 distinct devices in seven days',
      }),
      expect.objectContaining({
        id: reopened.data,
        status: 'open',
        description: 'new observation after closure',
      }),
    ]);
  });

  it('does not let an operator note make an old critical signal look newly observed', async () => {
    const created = await upsertSignal(service, {
      severity: 'critical',
      entityId: 'operator-note-clock',
    });
    expect(created.error).toBeNull();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const aged = await service.from('fraud_signals').update({
      last_observed_at: old,
      updated_at: old,
    }).eq('id', created.data);
    expect(aged.error).toBeNull();

    const annotatedAt = new Date().toISOString();
    const annotated = await service.from('fraud_signals').update({
      resolution_note: 'operator context only',
      updated_at: annotatedAt,
    }).eq('id', created.data);
    expect(annotated.error).toBeNull();

    const row = (await rowsFor('operator-note-clock'))[0]!;
    expect(new Date(row.last_observed_at).getTime()).toBe(new Date(old).getTime());
    expect(new Date(row.updated_at).getTime()).toBe(new Date(annotatedAt).getTime());

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [detectorWindow, genericEditWindow] = await Promise.all([
      service.from('fraud_signals')
        .select('*', { count: 'exact', head: true })
        .eq('id', created.data)
        .gte('last_observed_at', since),
      service.from('fraud_signals')
        .select('*', { count: 'exact', head: true })
        .eq('id', created.data)
        .gte('updated_at', since),
    ]);
    expect(detectorWindow.error).toBeNull();
    expect(detectorWindow.count).toBe(0);
    expect(genericEditWindow.error).toBeNull();
    expect(genericEditWindow.count).toBe(1);
  });

  it('uses one observation clock for refreshed dashboard signals and a new bot signal', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (const entityId of ['mixed-a', 'mixed-b']) {
      const seeded = await upsertSignal(service, { severity: 'critical', entityId });
      expect(seeded.error).toBeNull();
      const aged = await service.from('fraud_signals').update({
        created_at: old,
        updated_at: old,
        last_observed_at: old,
      }).eq('id', seeded.data);
      expect(aged.error).toBeNull();
    }

    for (const entityId of ['mixed-a', 'mixed-b']) {
      const refreshed = await upsertSignal(service, {
        severity: 'critical',
        entityId,
        description: `refreshed ${entityId}`,
      });
      expect(refreshed.error).toBeNull();
    }

    const botInsert = await service.from('fraud_signals').insert({
      guild_id: guildId,
      signal_type: 'payment_pattern',
      severity: 'critical',
      entity_type: 'customer',
      entity_id: 'mixed-bot-new',
      discord_id: 'discord-1',
      description: 'new bot critical observation',
      evidence: { source: 'bot' },
      status: 'open',
    });
    expect(botInsert.error).toBeNull();

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [observationWindow, creationWindow] = await Promise.all([
      service.from('fraud_signals')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .eq('status', 'open')
        .eq('severity', 'critical')
        .gte('last_observed_at', since),
      service.from('fraud_signals')
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId)
        .eq('status', 'open')
        .eq('severity', 'critical')
        .gte('created_at', since),
    ]);
    expect(observationWindow.error).toBeNull();
    expect(observationWindow.count).toBe(3);
    expect(creationWindow.error).toBeNull();
    expect(creationWindow.count).toBe(1);
  });

  it('permits service_role but denies anon and authenticated callers', async () => {
    const anonResult = await upsertSignal(anon, { entityId: 'anon-key' });
    const authenticatedResult = await upsertSignal(authenticated, { entityId: 'auth-key' });
    const serviceResult = await upsertSignal(service, { entityId: 'service-key' });

    expect(anonResult.error).not.toBeNull();
    expect(authenticatedResult.error).not.toBeNull();
    expect(serviceResult.error).toBeNull();
    expect(await rowsFor('anon-key')).toHaveLength(0);
    expect(await rowsFor('auth-key')).toHaveLength(0);
    expect(await rowsFor('service-key')).toHaveLength(1);
  });

  it('rejects unsupported severities before writing a row', async () => {
    const result = await upsertSignal(service, {
      severity: 'urgent',
      entityId: 'invalid-severity-key',
    });

    expect(result.error).toMatchObject({ code: '22023' });
    expect(await rowsFor('invalid-severity-key')).toHaveLength(0);
  });
});
