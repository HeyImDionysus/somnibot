import { describe, expect, it } from 'vitest';
import {
  activityDescription,
  activityType,
  buildActivityEvent,
} from '@/lib/dashboard/activity';

describe('dashboard activity projection', () => {
  it('preserves exact action meaning instead of labeling every giveaway as ended', () => {
    expect(activityType('giveaway.started')).toBe('giveaway.started');
    expect(activityType('giveaway.paused')).toBe('giveaway.paused');
  });

  it('shows unknown cross-surface activity instead of silently dropping it', () => {
    const event = buildActivityEvent({
      action: 'rbac.role_updated',
      details: null,
      timestamp: '2026-07-30T12:00:00.000Z',
      target_type: 'role',
      target_id: 'staff',
      success: true,
    });

    expect(event).toMatchObject({
      type: 'rbac',
      action: 'rbac.role_updated',
      description: 'Rbac Role Updated',
    });
    expect(event).not.toHaveProperty('targetType');
    expect(event).not.toHaveProperty('targetId');
  });

  it('keeps specific operator-friendly descriptions for known events', () => {
    expect(activityDescription('moderation.ban', { reason: 'spam' }, 'member', '123'))
      .toBe('Member banned: spam');
  });

  it('rejects malformed rows rather than inventing activity', () => {
    expect(buildActivityEvent({ action: '', timestamp: 'not-a-date' })).toBeNull();
  });
});
