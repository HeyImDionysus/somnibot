/**
 * comm-channels schema validation — FLEET_BACKLOG fixes.
 *
 *  - community-statistics-channels: name_format missing the {value} placeholder
 *    must be rejected (was accepted, rendering a static channel name).
 *  - community-temporary-channels: allow_claim + empty_grace_seconds controls
 *    must be accepted by the create schema.
 *  - community-scheduled-messages: missed_run_policy control must be accepted /
 *    constrained to the catalog enum.
 */
import { describe, it, expect } from 'vitest';
import { schemas } from '@/lib/api/validation';

describe('statsChannel.create name_format placeholder', () => {
  it('rejects a name_format with no {value}/{count} placeholder', () => {
    const result = schemas.statsChannel.create.safeParse({
      stat_type: 'total_members',
      name_format: '📊 Members',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /placeholder/i.test(i.message))).toBe(true);
    }
  });

  it('accepts a name_format containing {value}', () => {
    const result = schemas.statsChannel.create.safeParse({
      stat_type: 'total_members',
      name_format: '📊 Members: {value}',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a name_format containing {count} (alias)', () => {
    const result = schemas.statsChannel.create.safeParse({
      stat_type: 'total_members',
      name_format: 'Members {count}',
    });
    expect(result.success).toBe(true);
  });
});

describe('tempChannel.create new controls', () => {
  it('accepts allow_claim and empty_grace_seconds', () => {
    const result = schemas.tempChannel.create.safeParse({
      hub_channel_id: '123456789012345678',
      allow_claim: false,
      empty_grace_seconds: 15,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty_grace_seconds above the 3600s cap', () => {
    const result = schemas.tempChannel.create.safeParse({
      hub_channel_id: '123456789012345678',
      empty_grace_seconds: 100000,
    });
    expect(result.success).toBe(false);
  });
});

describe('scheduledMessage.create missed_run_policy', () => {
  it('accepts the send-latest policy', () => {
    const result = schemas.scheduledMessage.create.safeParse({
      name: 'Daily',
      channel_id: '123456789012345678',
      cron_expression: '0 9 * * *',
      missed_run_policy: 'send-latest',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown policy value', () => {
    const result = schemas.scheduledMessage.create.safeParse({
      name: 'Daily',
      channel_id: '123456789012345678',
      cron_expression: '0 9 * * *',
      missed_run_policy: 'retry-forever',
    });
    expect(result.success).toBe(false);
  });
});
