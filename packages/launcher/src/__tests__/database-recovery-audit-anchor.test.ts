import { describe, expect, it, vi } from 'vitest';
import { retainedBackupAuditOccurrenceKey, verifyRetainedBackupAudit } from '../main/database-recovery-audit-anchor.js';

const context = {
  supabaseUrl: 'https://sourceproject.supabase.co',
  supabaseSecretKey: 'audit-secret',
  guildId: '123456789012345678',
};
const anchor = {
  backupId: '11111111-1111-4111-8111-111111111111',
  sourceProjectRef: 'sourceproject',
  checksumSha256: 'a'.repeat(64),
};

describe('retained database backup audit anchor', () => {
  it('accepts one exact source-side occurrence anchor after mutable audit details are anonymized', async () => {
    // Given a bounded retained audit row containing only the non-sensitive append-only occurrence anchor.
    const occurrenceKey = retainedBackupAuditOccurrenceKey(anchor);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ occurrence_key: occurrenceKey }]), { status: 200 }));

    // When retained-backup authenticity is verified.
    const result = await verifyRetainedBackupAudit(context, anchor, { fetchImpl });

    // Then the receipt authenticates and the credential remains header-only.
    expect(result).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));
    expect(requestUrl.searchParams.get('limit')).toBe('2');
    expect(requestUrl.searchParams.get('guild_id')).toBe(`eq.${context.guildId}`);
    expect(requestUrl.searchParams.get('occurrence_key')).toBe(`eq.${occurrenceKey}`);
    expect(requestUrl.searchParams.has('target_id')).toBe(false);
    expect([...requestUrl.searchParams.keys()].some((key) => key.startsWith('details'))).toBe(false);
    expect(JSON.stringify(url)).not.toContain('audit-secret');
    expect(JSON.stringify(init?.headers)).toContain('audit-secret');
  });

  it('fails closed on missing, mismatched, duplicate, oversized, or unavailable receipts', async () => {
    // Given remote responses that cannot prove one exact receipt.
    const cases = [
      new Response('[]', { status: 200 }),
      new Response(JSON.stringify([{ occurrence_key: retainedBackupAuditOccurrenceKey({ ...anchor, checksumSha256: 'b'.repeat(64) }) }]), { status: 200 }),
      new Response(JSON.stringify([{ occurrence_key: retainedBackupAuditOccurrenceKey(anchor) }, { occurrence_key: retainedBackupAuditOccurrenceKey(anchor) }]), { status: 200 }),
      new Response('x'.repeat(20_000), { status: 200 }),
      new Response('', { status: 503 }),
    ];

    // When each response crosses the authenticity boundary.
    const results = await Promise.all(cases.map(async (response) => verifyRetainedBackupAudit(context, anchor, {
      fetchImpl: vi.fn(async () => response),
    })));

    // Then none can authenticate retained local bytes.
    expect(results).toEqual([false, false, false, false, false]);
  });
});
