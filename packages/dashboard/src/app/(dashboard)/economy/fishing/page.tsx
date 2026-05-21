'use client';

import { useState, useEffect, useCallback } from 'react';
import { Fish, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useGuildConfig, useUpdateGuildConfig } from '@/hooks/use-guild-config';
import { toast } from '@/hooks/use-toast';

// ── Types ──────────────────────────────────────────────────

interface FishSpecies {
  id: string;
  name: string;
  emoji: string;
  rarity: string;
  min_weight: number;
  max_weight: number;
  base_price: number;
  active: boolean;
}

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

const RARITY_COLORS: Record<string, string> = {
  common: 'text-gray-400',
  uncommon: 'text-green-400',
  rare: 'text-blue-400',
  epic: 'text-purple-400',
  legendary: 'text-orange-400',
};

const BLANK_SPECIES: Omit<FishSpecies, 'id'> = {
  name: '',
  emoji: '🐟',
  rarity: 'common',
  min_weight: 0.5,
  max_weight: 5.0,
  base_price: 10,
  active: true,
};

// ── Page ───────────────────────────────────────────────────

export default function FishingPage() {
  const { data: config, isLoading: configLoading } = useGuildConfig();
  const updateConfig = useUpdateGuildConfig();

  const [species, setSpecies] = useState<FishSpecies[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSpecies, setEditingSpecies] = useState<(Omit<FishSpecies, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchSpecies = useCallback(async () => {
    try {
      const res = await fetch('/api/economy/fishing');
      if (res.ok) {
        const json = await res.json();
        setSpecies(json.data ?? []);
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load fish species.', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSpecies();
  }, [fetchSpecies]);

  // ── Config toggles ─────────────────────────────────────

  const handleConfigChange = async (key: string, value: boolean | number) => {
    try {
      await updateConfig.mutateAsync({ [key]: value });
      toast({ title: 'Saved', description: 'Fishing config updated.', variant: 'success' });
    } catch {
      toast({ title: 'Error', description: 'Failed to save config.', variant: 'error' });
    }
  };

  // ── CRUD ───────────────────────────────────────────────

  const saveSpecies = async () => {
    if (!editingSpecies) return;
    setSaving(true);
    try {
      const method = editingSpecies.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/fishing', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingSpecies),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Saved', description: `Fish species ${editingSpecies.id ? 'updated' : 'created'}.`, variant: 'success' });
      setEditingSpecies(null);
      fetchSpecies();
    } catch {
      toast({ title: 'Error', description: 'Failed to save species.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteSpecies = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/fishing?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Deleted', description: 'Fish species removed.', variant: 'success' });
      setDeleteId(null);
      fetchSpecies();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete species.', variant: 'error' });
    }
  };

  if (configLoading || loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎣 Fishing</h1>
          <p className="text-muted-foreground">Manage fish species, rarity weights, and fishing settings.</p>
        </div>
        <Button onClick={() => setEditingSpecies({ ...BLANK_SPECIES })}>
          <Plus className="h-4 w-4 mr-2" /> Add Species
        </Button>
      </div>

      {/* Config */}
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <Label>Fishing Enabled</Label>
            <input
              type="checkbox"
              checked={config?.economy_fishing_enabled ?? false}
              onChange={(e) => handleConfigChange('economy_fishing_enabled', e.target.checked)}
              className="toggle"
            />
          </div>
          <div>
            <Label>Cooldown (seconds)</Label>
            <Input
              type="number"
              value={config?.economy_fishing_cooldown_seconds ?? 30}
              onChange={(e) => handleConfigChange('economy_fishing_cooldown_seconds', parseInt(e.target.value) || 30)}
              min={5}
              max={3600}
            />
          </div>
          <div>
            <Label>Junk Chance (%)</Label>
            <Input
              type="number"
              value={config?.economy_fishing_junk_chance_pct ?? 15}
              onChange={(e) => handleConfigChange('economy_fishing_junk_chance_pct', parseInt(e.target.value) || 15)}
              min={0}
              max={100}
            />
          </div>
          <div>
            <Label>Treasure Chance (%)</Label>
            <Input
              type="number"
              value={config?.economy_fishing_treasure_chance_pct ?? 5}
              onChange={(e) => handleConfigChange('economy_fishing_treasure_chance_pct', parseInt(e.target.value) || 5)}
              min={0}
              max={100}
            />
          </div>
        </div>
      </Card>

      {/* Species List */}
      {species.length === 0 ? (
        <EmptyState
          icon={Fish}
          title="No fish species yet"
          description="Add your first fish species to get started."
          action={{
            label: 'Add Species',
            onClick: () => setEditingSpecies({ ...BLANK_SPECIES }),
          }}
        />
      ) : (
        <div className="grid gap-3">
          {species.map((s) => (
            <Card key={s.id} className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{s.emoji}</span>
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <p className={`text-sm ${RARITY_COLORS[s.rarity] ?? 'text-muted-foreground'}`}>
                    {s.rarity.toUpperCase()} • {s.min_weight}–{s.max_weight} kg • 💰 {s.base_price}/ea
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" onClick={() => setEditingSpecies(s)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setDeleteId(s.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      {editingSpecies && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <Card className="p-6 w-full max-w-lg space-y-4">
            <h2 className="text-lg font-semibold">{editingSpecies.id ? 'Edit' : 'New'} Fish Species</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={editingSpecies.name} onChange={(e) => setEditingSpecies({ ...editingSpecies, name: e.target.value })} />
                </div>
                <div>
                  <Label>Emoji</Label>
                  <Input value={editingSpecies.emoji} onChange={(e) => setEditingSpecies({ ...editingSpecies, emoji: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Rarity</Label>
                <Select value={editingSpecies.rarity} onValueChange={(v) => setEditingSpecies({ ...editingSpecies, rarity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RARITIES.map((r) => (
                      <SelectItem key={r} value={r}>{r.toUpperCase()}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Min Weight</Label>
                  <Input type="number" step="0.1" value={editingSpecies.min_weight} onChange={(e) => setEditingSpecies({ ...editingSpecies, min_weight: parseFloat(e.target.value) || 0 })} />
                </div>
                <div>
                  <Label>Max Weight</Label>
                  <Input type="number" step="0.1" value={editingSpecies.max_weight} onChange={(e) => setEditingSpecies({ ...editingSpecies, max_weight: parseFloat(e.target.value) || 0 })} />
                </div>
                <div>
                  <Label>Base Price</Label>
                  <Input type="number" value={editingSpecies.base_price} onChange={(e) => setEditingSpecies({ ...editingSpecies, base_price: parseInt(e.target.value) || 0 })} />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingSpecies(null)}>Cancel</Button>
              <Button onClick={saveSpecies} disabled={saving || !editingSpecies.name}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Species"
        description="Are you sure you want to delete this fish species? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteSpecies}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
