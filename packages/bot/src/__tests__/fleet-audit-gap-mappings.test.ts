import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../features/audit/audit-service.js';

function harness() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const handlers: Array<(event: any) => void> = [];
  const bus = { onAny: (handler: any) => handlers.push(handler), offAny: vi.fn() };
  const supabase = { from: vi.fn().mockReturnValue({ upsert }) };
  const service = new AuditService('g1', supabase as any, bus as any);
  service.start();
  return { service, upsert, emit: (type: string, data: Record<string, unknown>) => handlers.forEach((handler) => handler({ type, guildId: 'g1', timestamp: Date.now(), data })) };
}

describe('fleet audit gap mappings', () => {
  it.each([
    ['poll.late_interaction_rejected', 'polls.late_interaction_rejected', { pollId: 'p1', actorId: 'u1', action: 'vote', reason: 'closed', occurrenceId: 'o1' }],
    ['prediction.resolve_rejected', 'polls.resolve_rejected', { predictionId: 'p1', actorId: 'u1', reason: 'invalid_winner', occurrenceId: 'o2' }],
    ['prediction.settlement_payout_retried', 'polls.settlement_payout_retried', { predictionId: 'p1', betId: 'b1', winnerId: 'u1', settlementType: 'prediction_payout', occurrenceId: 'o3' }],
    ['scheduled_message.channel_missing', 'scheduled_messages.channel_missing', { scheduleId: 's1', name: 'Daily', channelId: 'c1', occurrenceId: 'o4' }],
    ['scheduled_message.send_retried', 'scheduled_messages.send_retried', { scheduleId: 's1', name: 'Daily', channelId: 'c1', attempt: 2, backoffMs: 500, occurrenceId: 'o5' }],
    ['temp_channel.creation_retried', 'temp_channels.creation_retried', { hubId: 'h1', hubChannelId: 'hvc', memberId: 'u1', attempt: 2, backoffMs: 250, occurrenceId: 'o6' }],
    ['temp_channel.creation_failed', 'temp_channels.creation_failed', { hubId: 'h1', hubChannelId: 'hvc', memberId: 'u1', error: 'forbidden', occurrenceId: 'o6b' }],
    ['temp_channel.orphan_reconciled', 'temp_channels.orphan_reconciled', { channelId: 'c1', ownerId: 'u1', occurrenceId: 'o6c' }],
    ['welcome.channel_missing', 'welcome.channel_missing', { memberId: 'u1', channelId: 'c1', occurrenceId: 'o7' }],
    ['welcome.dm_blocked_fallback', 'welcome.dm_blocked_fallback', { memberId: 'u1', occurrenceId: 'o8' }],
    ['welcome.member_role_grant_failed', 'welcome.member_role_grant_failed', { memberId: 'u1', roleId: 'r1', attempt: 2, occurrenceId: 'o9' }],
  ])('maps %s to %s', async (type, action, data) => {
    const { service, upsert, emit } = harness();
    emit(type, data);
    await (service as any).flush();
    service.stop();
    expect(upsert.mock.calls[0][0][0]).toMatchObject({ action, occurrence_key: expect.stringContaining(String(data.occurrenceId)) });
  });
});
