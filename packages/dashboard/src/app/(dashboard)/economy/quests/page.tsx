/**
 * Economy Quests Management — quest template CRUD + quest settings.
 * FAKE economy only.
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ScrollText, Plus, Pencil, Trash2 } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

interface QuestTemplate {
  id: string;
  quest_type: string;
  title: string;
  description: string;
  action_type: string;
  target_count: number;
  reward_currency: number;
  reward_xp: number;
  required_module: string | null;
  active: boolean;
}

interface QuestsConfig {
  economy_quests_enabled: boolean;
  economy_daily_quest_count: number;
  economy_weekly_quest_count: number;
  economy_quest_reward_base: number;
}

const DEFAULT_CONFIG: QuestsConfig = {
  economy_quests_enabled: false,
  economy_daily_quest_count: 3,
  economy_weekly_quest_count: 5,
  economy_quest_reward_base: 100,
};

const BLANK_QUEST: Omit<QuestTemplate, 'id'> & { id?: string } = {
  quest_type: 'daily',
  title: '',
  description: '',
  action_type: 'work',
  target_count: 1,
  reward_currency: 100,
  reward_xp: 50,
  required_module: null,
  active: true,
};

export default function QuestsPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<QuestsConfig>(DEFAULT_CONFIG);
  const [quests, setQuests] = useState<QuestTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<QuestTemplate, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, questsRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/quests'),
      ]);
      if (cfgRes.ok) {
        const json = await cfgRes.json();
        const gc = json.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (questsRes.ok) {
        const qJson = await questsRes.json();
        setQuests(qJson.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load quest data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<QuestsConfig>) => {
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setConfig({
        economy_quests_enabled: readConfirmedBoolean(result.config, 'economy_quests_enabled'),
        economy_daily_quest_count: readConfirmedNumber(result.config, 'economy_daily_quest_count'),
        economy_weekly_quest_count: readConfirmedNumber(result.config, 'economy_weekly_quest_count'),
        economy_quest_reward_base: readConfirmedNumber(result.config, 'economy_quest_reward_base'),
      });
      if (result.status === 'failed') {
        toast({ title: 'Failed to save settings', variant: 'error' });
        return 'failed' as const;
      }
      toast({ title: 'Settings saved!', variant: 'success' });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
      return 'failed' as const;
    }
  };

  const saveQuest = async () => {
    if (!editing || !editing.title.trim()) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/quests', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error();
      toast({ title: editing.id ? 'Quest updated!' : 'Quest created!', variant: 'success' });
      setEditing(null);
      loadData();
    } catch {
      toast({ title: 'Failed to save quest', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteQuest = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/quests?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast({ title: 'Quest deleted', variant: 'success' });
      setDeleteId(null);
      loadData();
    } catch {
      toast({ title: 'Failed to delete quest', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Quests</h1>
          <p className="text-discord-text-secondary">Manage daily/weekly quest templates and rewards.</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={config.economy_quests_enabled}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_quests_enabled: e.target.checked })}
            className="rounded" />
          <span className="text-sm text-discord-text-primary">Enable Quests</span>
        </label>
      </div>

      {!config.economy_quests_enabled ? (
        <EmptyState icon={ScrollText} title="Quests Disabled" description="Enable quests above to give users daily and weekly challenges." />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-discord-bg-secondary rounded-lg p-4"><ValidatedNumberInput label="Daily Quest Count" help="Quest slots assigned to each member every day." value={config.economy_daily_quest_count} onCommit={(value) => saveConfig({ economy_daily_quest_count: value })} min={1} max={10} /></div>
            <div className="bg-discord-bg-secondary rounded-lg p-4"><ValidatedNumberInput label="Weekly Quest Count" help="Quest slots assigned to each member every week." value={config.economy_weekly_quest_count} onCommit={(value) => saveConfig({ economy_weekly_quest_count: value })} min={1} max={5} /></div>
            <div className="bg-discord-bg-secondary rounded-lg p-4"><ValidatedNumberInput label="Base Quest Reward (coins)" help="Default coin reward before template overrides; 0 gives no coin reward." value={config.economy_quest_reward_base} onCommit={(value) => saveConfig({ economy_quest_reward_base: value })} min={0} /></div>
          </div>

          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-discord-text-primary">Quest Templates</h2>
            <button onClick={() => setEditing({ ...BLANK_QUEST })}
              className="flex items-center gap-1 bg-discord-accent text-white px-3 py-1.5 rounded text-sm hover:bg-discord-accent/80">
              <Plus className="w-4 h-4" /> Add Quest
            </button>
          </div>

          {quests.length === 0 ? (
            <EmptyState icon={ScrollText} title="No Quest Templates" description="Create quest templates above. They'll be randomly assigned to users daily." />
          ) : (
            <div className="space-y-2">
              {quests.map((q) => (
                <div key={q.id} className="flex flex-col items-stretch gap-3 rounded-lg bg-discord-bg-secondary p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <span className={`text-xs px-2 py-0.5 rounded ${q.quest_type === 'daily' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'}`}>
                      {q.quest_type}
                    </span>
                    <span className="ml-2 text-discord-text-primary font-medium">{q.title}</span>
                    <span className="ml-2 text-sm text-discord-text-secondary">
                      ({q.action_type} × {q.target_count}) — 💰 {q.reward_currency} + ✨ {q.reward_xp} XP
                    </span>
                  </div>
                  <div className="flex justify-end gap-1 sm:shrink-0">
                    <button type="button" aria-label={`Edit ${q.title}`} onClick={() => setEditing({ ...q })} className="flex h-11 w-11 items-center justify-center rounded hover:text-discord-accent text-discord-text-secondary"><Pencil className="w-4 h-4" /></button>
                    <button type="button" aria-label={`Delete ${q.title}`} onClick={() => setDeleteId(q.id)} className="flex h-11 w-11 items-center justify-center rounded hover:text-red-400 text-discord-text-secondary"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-discord-bg-secondary rounded-lg p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-discord-text-primary">{editing.id ? 'Edit' : 'New'} Quest</h3>
            <input placeholder="Title" value={editing.title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, title: e.target.value })}
              className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            <input placeholder="Description" value={editing.description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, description: e.target.value })}
              className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-discord-text-secondary">Type</label>
                <select value={editing.quest_type}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, quest_type: e.target.value })}
                  className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Action Type</label>
                <select value={editing.action_type}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, action_type: e.target.value })}
                  className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2">
                  <option value="work">Work (/work)</option>
                  <option value="crime">Crime (/crime)</option>
                  <option value="fish">Fish (/fish)</option>
                  <option value="gather">Gather (/gather)</option>
                  <option value="craft">Craft (/craft)</option>
                  <option value="farm">Farm (harvest)</option>
                  <option value="adventure">Adventure</option>
                  <option value="market_trade">Market Trade</option>
                  <option value="shop_buy">Shop Purchase</option>
                  <option value="chat">Chat Messages</option>
                  <option value="gamble">Casino Game</option>
                  <option value="heist">Heist</option>
                  <option value="lottery">Lottery Ticket</option>
                  <option value="poll_vote">Poll Vote</option>
                  <option value="pet_feed">Feed Pet</option>
                  <option value="pet_train">Train Pet</option>
                  <option value="trivia">Correct Trivia Answer</option>
                </select>
                <p className="mt-1 text-xs text-discord-text-muted">Only actions emitted by the live bot are available, so every saved quest can progress.</p>
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Target Count</label>
                <input type="number" min={1} value={editing.target_count}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, target_count: parseInt(e.target.value) || 1 })}
                  className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Reward (coins)</label>
                <input type="number" min={0} value={editing.reward_currency}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, reward_currency: parseInt(e.target.value) || 0 })}
                  className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Reward (XP)</label>
                <input type="number" min={0} value={editing.reward_xp}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, reward_xp: parseInt(e.target.value) || 0 })}
                  className="w-full bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-discord-text-primary">
              <input type="checkbox" checked={editing.active}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, active: e.target.checked })}
                className="rounded" />
              Assign this quest to members
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded text-discord-text-secondary hover:text-discord-text-primary">Cancel</button>
              <button onClick={saveQuest} disabled={saving}
                className="px-4 py-2 bg-discord-accent text-white rounded hover:bg-discord-accent/80 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        title="Delete Quest"
        description="Are you sure? Users with this quest assigned will lose their progress."
        variant="danger"
        onConfirm={deleteQuest}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
