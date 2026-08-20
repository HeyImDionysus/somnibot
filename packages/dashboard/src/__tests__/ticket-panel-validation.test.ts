import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

const basePanel = {
  name: 'Support',
  channel_id: '12345678901234567',
  open_category_id: '22345678901234567',
  manager_roles: [],
  ticket_types: [{ id: 'general', label: 'General', emoji: '🎫', color: 'blue' }],
};

describe('ticket panel validation', () => {
  it('accepts structured panel copy, lifecycle settings, and Discord intake questions', () => {
    const parsed = schemas.ticketPanel.create.safeParse({
      ...basePanel,
      panel_message: { title: 'Help desk', description: 'Choose a topic', footer: 'Private support' },
      inactivity_warn_hours: 24,
      inactivity_close_hours: 72,
      feedback_prompt_enabled: true,
      intake_form_enabled: true,
      intake_form_fields: [{
        id: 'problem',
        label: 'What do you need help with?',
        placeholder: 'Include the expected and actual result',
        style: 'paragraph',
        required: true,
        min_length: 10,
        max_length: 1000,
      }],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects intake forms Discord cannot render safely', () => {
    expect(schemas.ticketPanel.create.safeParse({
      ...basePanel,
      intake_form_enabled: true,
      intake_form_fields: Array.from({ length: 6 }, (_, index) => ({
        label: `Question ${index + 1}`,
        style: 'short',
        required: true,
      })),
    }).success).toBe(false);

    expect(schemas.ticketPanel.create.safeParse({
      ...basePanel,
      intake_form_enabled: true,
      intake_form_fields: [{ label: 'Question', min_length: 100, max_length: 10 }],
    }).success).toBe(false);
  });
});
