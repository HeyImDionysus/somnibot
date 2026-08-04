/**
 * Economy Achievements Management — achievement CRUD + prestige config.
 * FAKE economy only.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Trophy, Plus, Pencil, Trash2 } from 'lucide-react';

interface AchievementDef {
  id: string;
  name: string;
  description: string;
  badge_emoji: string;
  condition_type: string;
  condition_value: number;
  reward_currency: number;
  reward_xp: number;
  hidden: boolean;
}

interface AchConfig {
  economy_achievements_enabled: boolean;
  economy_prestige_enabled: boolean;
  economy_prestige_multiplier_pct: number;
  economy_prestige_min_level: number;
  economy_prestige_min_net_worth: number;
  economy_prestige_max_level: number;
}

const DEFAULT_CONFIG: AchConfig = {
  economy_achievements_enabled: false,
  economy_prestige_enabled: false,
  economy_prestige_multiplier_pct: 10,
  economy_prestige_min_level: 50,
  economy_prestige_min_net_worth: 1000000,
  economy_prestige_max_level: 10,
};

const BLANK_ACH: Omit<AchievementDef, 'id'> & { id?: string } = {
  name: '',
  description: '',
  badge_emoji: '🏆',
  condition_type: 'generic',
  condition_value: 1,
  reward_currency: 0,
  reward_xp: 0,
  hidden: false,
};

export default function AchievementsPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AchConfig>(DEFAULT_CONFIG);
  const [achievements, setAchievements] = useState<AchievementDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<AchievementDef, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, achRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/achievements'),
      ]);
      if (cfgRes.ok) {
        const json = await cfgRes.json();
        const gc = json.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (achRes.ok) {
        const aJson = await achRes.json();
        setAchievements(aJson.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load achievement data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<AchConfig>) => {
    const merged = { ...config, ...patch };
    setConfig(merged);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Settings saved!', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    }
  };

  const saveAchievement = async () => {
    if (!editing || !editing.name.trim()) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/achievements', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error();
      toast({ title: editing.id ? 'Achievement updated!' : 'Achievement created!', variant: 'success' });
      setEditing(null);
      loadData();
    } catch {
      toast({ title: 'Failed to save achievement', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteAchievement = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/achievements?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast({ title: 'Achievement deleted', variant: 'success' });
      setDeleteId(null);
      loadData();
    } catch {
      toast({ title: 'Failed to delete achievement', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Achievements & Prestige</h1>
          <p className="text-discord-text-secondary">Configure milestone badges and prestige system.</p>
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={config.economy_achievements_enabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_achievements_enabled: e.target.checked })}
              className="rounded" />
            <span className="text-sm text-discord-text-primary">Achievements</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={config.economy_prestige_enabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_prestige_enabled: e.target.checked })}
              className="rounded" />
            <span className="text-sm text-discord-text-primary">Prestige</span>
          </label>
        </div>
      </div>

      {/* Prestige settings */}
      {config.economy_prestige_enabled && (
        <div className="bg-discord-secondary rounded-lg p-4">
          <h3 className="font-semibold text-discord-text-primary mb-3">⭐ Prestige Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm text-discord-text-secondary">Multiplier Per Level (%)</label>
              <input type="number" min={1} max={100} value={config.economy_prestige_multiplier_pct}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_prestige_multiplier_pct: parseInt(e.target.value) || 10 })}
                className="w-full mt-1 bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Min Level Required</label>
              <input type="number" min={1} value={config.economy_prestige_min_level}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_prestige_min_level: parseInt(e.target.value) || 50 })}
                className="w-full mt-1 bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Min Net Worth</label>
              <input type="number" min={0} value={config.economy_prestige_min_net_worth}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_prestige_min_net_worth: parseInt(e.target.value) || 1000000 })}
                className="w-full mt-1 bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Maximum Prestige Level</label>
              <input type="number" min={1} max={2147483647} value={config.economy_prestige_max_level}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_prestige_max_level: parseInt(e.target.value, 10) || 10 })}
                className="w-full mt-1 bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
          </div>
        </div>
      )}

      {/* Achievement list */}
      {config.economy_achievements_enabled && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-discord-text-primary">Achievement Definitions</h2>
            <button onClick={() => setEditing({ ...BLANK_ACH })}
              className="flex items-center gap-1 bg-discord-blurple text-white px-3 py-1.5 rounded text-sm hover:bg-discord-blurple/80">
              <Plus className="w-4 h-4" /> Add Achievement
            </button>
          </div>

          {achievements.length === 0 ? (
            <EmptyState icon={Trophy} title="No Achievements" description="Create achievements that users can unlock by reaching milestones." />
          ) : (
            <div className="space-y-2">
              {achievements.map((a) => (
                <div key={a.id} className="bg-discord-secondary rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <span className="text-xl mr-2">{a.badge_emoji}</span>
                    <span className="text-discord-text-primary font-medium">{a.name}</span>
                    {a.hidden && <span className="ml-2 text-xs text-discord-text-secondary italic">(hidden)</span>}
                    <span className="ml-2 text-sm text-discord-text-secondary">
                      {a.condition_type} ≥ {a.condition_value}
                      {a.reward_currency > 0 && ` — 💰 ${a.reward_currency}`}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEditing({ ...a })} className="p-1 hover:text-discord-blurple text-discord-text-secondary"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => setDeleteId(a.id)} className="p-1 hover:text-red-400 text-discord-text-secondary"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!config.economy_achievements_enabled && !config.economy_prestige_enabled && (
        <EmptyState icon={Trophy} title="Achievements & Prestige Disabled" description="Enable at least one feature above to configure it." />
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-discord-secondary rounded-lg p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-discord-text-primary">{editing.id ? 'Edit' : 'New'} Achievement</h3>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-discord-text-secondary">Emoji</label>
                <input value={editing.badge_emoji}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, badge_emoji: e.target.value })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2 text-center text-xl" />
              </div>
              <div className="col-span-3">
                <label className="text-xs text-discord-text-secondary">Name</label>
                <input value={editing.name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
            </div>
            <input placeholder="Description" value={editing.description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, description: e.target.value })}
              className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-discord-text-secondary">Condition Type</label>
                <input value={editing.condition_type}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, condition_type: e.target.value })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Condition Value</label>
                <input type="number" min={1} value={editing.condition_value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, condition_value: parseInt(e.target.value) || 1 })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Reward (coins)</label>
                <input type="number" min={0} value={editing.reward_currency}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, reward_currency: parseInt(e.target.value) || 0 })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
              <div>
                <label className="text-xs text-discord-text-secondary">Reward XP</label>
                <input type="number" min={0} value={editing.reward_xp}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, reward_xp: parseInt(e.target.value) || 0 })}
                  className="w-full bg-discord-tertiary text-discord-text-primary rounded px-3 py-2" />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={editing.hidden}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, hidden: e.target.checked })}
                className="rounded" />
              <span className="text-sm text-discord-text-primary">Hidden (shown as ❓ until unlocked)</span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded text-discord-text-secondary hover:text-discord-text-primary">Cancel</button>
              <button onClick={saveAchievement} disabled={saving}
                className="px-4 py-2 bg-discord-blurple text-white rounded hover:bg-discord-blurple/80 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        title="Delete Achievement"
        description="Are you sure? Users who earned this badge will lose it."
        variant="danger"
        onConfirm={deleteAchievement}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
