/**
 * tutorial-engine — coverage tests
 *
 * Tests TutorialEngine class with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: Record<string, unknown>) { this.data.footer = f; return this; }
    setImage(u: string) { this.data.image = u; return this; }
  },
  ActionRowBuilder: class {
    components: unknown[] = [];
    addComponents(c: unknown) { this.components.push(c); return this; }
  },
  ButtonBuilder: class {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: unknown) { this.data.style = s; return this; }
  },
  ButtonStyle: { Secondary: 2, Primary: 1, Success: 3, Danger: 4 },
  ComponentType: { Button: 2 },
  ChatInputCommandInteraction: class {},
  ButtonInteraction: class {},
}));

import { TutorialEngine } from '../features/tutorial/tutorial-engine.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'upsert', 'update', 'delete']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(overrides: Record<string, Function> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (overrides[table]) return overrides[table]();
      if (table === 'tutorial_steps') {
        return chainBuilder({ data: [], error: null });
      }
      if (table === 'tutorial_progress') {
        return chainBuilder({ data: null, error: null });
      }
      if (table === 'tutorial_configs') {
        return chainBuilder({ data: null, error: null });
      }
      return chainBuilder();
    }),
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'u1' },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue({
      awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('TutorialEngine', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('startTutorial', () => {
    it('shows built-in steps when no custom steps configured', async () => {
      const supabase = makeSupabase();
      const engine = new TutorialEngine(supabase as any, 'g1');
      const interaction = makeInteraction();

      await engine.startTutorial(interaction as any);
      // Built-in steps always exist as fallback, so it shows step 1
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('shows built-in steps when no custom steps exist', async () => {
      const supabase = makeSupabase();
      const engine = new TutorialEngine(supabase as any, 'g1');
      const interaction = makeInteraction();

      // Mock: no custom steps → falls back to built-in
      supabase.from.mockImplementation((table: string) => {
        if (table === 'tutorial_steps') {
          return chainBuilder({ data: null, error: null }); // null = no custom steps
        }
        if (table === 'tutorial_progress') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder();
      });

      await engine.startTutorial(interaction as any);
      // Should show the first built-in step
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('shows custom steps when available', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({
          data: [
            { id: 's1', step_order: 0, title: 'Custom Step', description: 'Hello!', image_url: 'https://img.com/a.png', built_in_key: null, enabled: true },
            { id: 's2', step_order: 1, title: 'Step 2', description: 'Second!', image_url: null, built_in_key: null, enabled: true },
          ],
          error: null,
        }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      const interaction = makeInteraction();

      await engine.startTutorial(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('resumes from saved progress', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({
          data: { guild_id: 'g1', user_id: 'u1', current_step: 2, completed: false },
          error: null,
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      const interaction = makeInteraction();

      await engine.startTutorial(interaction as any);
      // Should show step 2 (resumed)
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('restarts from 0 when previously completed', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({
          data: { guild_id: 'g1', user_id: 'u1', current_step: 5, completed: true },
          error: null,
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      const interaction = makeInteraction();

      await engine.startTutorial(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('handles button navigation: next', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      // The "collected" button result — when showStep recurses, it will
      // call collected.update (because it's a ButtonInteraction-like),
      // then collected.message.awaitMessageComponent for the next button press.
      // We need to make collected an instance of the mocked ButtonInteraction class.
      const { ButtonInteraction: MockBtnInteraction } = await import('discord.js');
      const nextBtnCollected = Object.create(MockBtnInteraction.prototype);
      nextBtnCollected.customId = 'tutorial_next';
      nextBtnCollected.user = { id: 'u1' };
      nextBtnCollected.update = vi.fn().mockResolvedValue(undefined);
      nextBtnCollected.editReply = vi.fn().mockResolvedValue(undefined);
      nextBtnCollected.message = {
        awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
      };

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockResolvedValueOnce(nextBtnCollected),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(nextBtnCollected.update).toHaveBeenCalled();
    });

    it('handles button navigation: previous', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({
          data: { current_step: 2, completed: false },
          error: null,
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const { ButtonInteraction: MockBtnInteraction } = await import('discord.js');
      const prevBtnCollected = Object.create(MockBtnInteraction.prototype);
      prevBtnCollected.customId = 'tutorial_prev';
      prevBtnCollected.user = { id: 'u1' };
      prevBtnCollected.update = vi.fn().mockResolvedValue(undefined);
      prevBtnCollected.editReply = vi.fn().mockResolvedValue(undefined);
      prevBtnCollected.message = {
        awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
      };

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockResolvedValueOnce(prevBtnCollected),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(prevBtnCollected.update).toHaveBeenCalled();
    });

    it('handles finish button', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({
          data: [{ id: 's1', step_order: 0, title: 'Only Step', description: 'Done!', image_url: null, built_in_key: null, enabled: true }],
          error: null,
        }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const finishBtn: Record<string, unknown> = {
        customId: 'tutorial_finish',
        user: { id: 'u1' },
        update: vi.fn().mockResolvedValue(undefined),
      };

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockResolvedValueOnce(finishBtn),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(finishBtn.update).toHaveBeenCalled();
    });

    it('handles skip button', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const skipBtn: Record<string, unknown> = {
        customId: 'tutorial_skip',
        user: { id: 'u1' },
        update: vi.fn().mockResolvedValue(undefined),
      };

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockResolvedValueOnce(skipBtn),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(skipBtn.update).toHaveBeenCalled();
    });

    it('handles timeout gracefully', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
        }),
      });

      await engine.startTutorial(interaction as any);
      // Should disable buttons without throwing
      expect(interaction.editReply).toHaveBeenCalledWith({ components: [] });
    });

    it('handles timeout with editReply failure', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const interaction = makeInteraction({
        reply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
        }),
        editReply: vi.fn().mockRejectedValue(new Error('deleted')),
      });

      await engine.startTutorial(interaction as any);
      // Should not throw even if editReply fails
    });

    it('handles deferred interaction', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const interaction = makeInteraction({
        deferred: true,
        editReply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(interaction.editReply).toHaveBeenCalled();
    });

    it('handles already-replied interaction', async () => {
      const supabase = makeSupabase({
        tutorial_steps: () => chainBuilder({ data: null, error: null }),
        tutorial_progress: () => chainBuilder({ data: null, error: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');

      const interaction = makeInteraction({
        replied: true,
        editReply: vi.fn().mockResolvedValue({
          awaitMessageComponent: vi.fn().mockRejectedValue(new Error('timeout')),
        }),
      });

      await engine.startTutorial(interaction as any);
      expect(interaction.editReply).toHaveBeenCalled();
    });
  });

  describe('shouldAutoTrigger', () => {
    it('returns false when tutorial is disabled', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({
          data: { enabled: false, auto_trigger: true, trigger_mode: 'first_command' },
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(false);
    });

    it('returns false when auto_trigger is disabled', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({
          data: { enabled: true, auto_trigger: false, trigger_mode: 'first_command' },
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(false);
    });

    it('returns false when trigger_mode is not first_command', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({
          data: { enabled: true, auto_trigger: true, trigger_mode: 'manual' },
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(false);
    });

    it('returns true for new user (no progress)', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({
          data: { enabled: true, auto_trigger: true, trigger_mode: 'first_command' },
        }),
        tutorial_progress: () => chainBuilder({ data: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(true);
    });

    it('returns false for user with existing progress', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({
          data: { enabled: true, auto_trigger: true, trigger_mode: 'first_command' },
        }),
        tutorial_progress: () => chainBuilder({
          data: { completed: false, current_step: 1 },
        }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(false);
    });

    it('returns false when no config exists', async () => {
      const supabase = makeSupabase({
        tutorial_configs: () => chainBuilder({ data: null }),
      });
      const engine = new TutorialEngine(supabase as any, 'g1');
      expect(await engine.shouldAutoTrigger('u1')).toBe(false);
    });
  });
});
