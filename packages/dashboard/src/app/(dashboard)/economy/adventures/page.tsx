'use client';

import { useState, useEffect, useCallback } from 'react';
import { Swords, Plus, Pencil, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface Adventure {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  adventure_type: string;
  difficulty: string;
  min_scenes: number;
  max_scenes: number;
  active: boolean;
}

const TYPES = ['dungeon', 'forest', 'ocean', 'space', 'mountain'] as const;
const DIFFICULTIES = ['easy', 'normal', 'hard', 'legendary'] as const;
const TYPE_EMOJI: Record<string, string> = {
  dungeon: '🏰', forest: '🌲', ocean: '🌊', space: '🚀', mountain: '⛰️',
};

const BLANK_ADVENTURE: Omit<Adventure, 'id'> = {
  name: '',
  emoji: '⚔️',
  description: '',
  adventure_type: 'dungeon',
  difficulty: 'normal',
  min_scenes: 5,
  max_scenes: 10,
  active: true,
};

// ── Page ───────────────────────────────────────────────────

export default function AdventuresPage() {
  const { data: config, isLoading: configLoading } = useGuildConfig();
  const updateConfig = useUpdateGuildConfig();

  const [adventures, setAdventures] = useState<Adventure[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<Adventure, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchAdventures = useCallback(async () => {
    try {
      const res = await fetch('/api/economy/adventures');
      if (res.ok) {
        const json = await res.json();
        setAdventures(json.data ?? []);
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load adventures.', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAdventures();
  }, [fetchAdventures]);

  const handleConfigChange = async (key: string, value: boolean | number) => {
    try {
      await updateConfig.mutateAsync({ [key]: value });
      toast({ title: 'Saved', description: 'Adventures config updated.', variant: 'success' });
    } catch {
      toast({ title: 'Error', description: 'Failed to save config.', variant: 'error' });
    }
  };

  const saveAdventure = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/adventures', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Saved', description: `Adventure ${editing.id ? 'updated' : 'created'}.`, variant: 'success' });
      setEditing(null);
      fetchAdventures();
    } catch {
      toast({ title: 'Error', description: 'Failed to save adventure.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteAdventure = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/adventures?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Deleted', description: 'Adventure removed.', variant: 'success' });
      setDeleteId(null);
      fetchAdventures();
    } catch {
      toast({ title: 'Error', description: 'Failed to delete adventure.', variant: 'error' });
    }
  };

  if (configLoading || loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">⚔️ Adventures</h1>
          <p className="text-muted-foreground">Manage interactive story adventures with scenes and choices.</p>
        </div>
        <Button onClick={() => setEditing({ ...BLANK_ADVENTURE })}>
          <Plus className="h-4 w-4 mr-2" /> Add Adventure
        </Button>
      </div>

      {/* Config */}
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <Label>Adventures Enabled</Label>
            <input
              type="checkbox"
              checked={config?.economy_adventures_enabled ?? false}
              onChange={(e) => handleConfigChange('economy_adventures_enabled', e.target.checked)}
              className="toggle"
            />
          </div>
          <div>
            <Label>Daily Limit</Label>
            <Input
              type="number"
              value={config?.economy_adventure_daily_limit ?? 3}
              onChange={(e) => handleConfigChange('economy_adventure_daily_limit', parseInt(e.target.value) || 3)}
              min={1}
              max={50}
            />
          </div>
          <div>
            <Label>Ticket Cost (coins)</Label>
            <Input
              type="number"
              value={config?.economy_adventure_ticket_cost ?? 100}
              onChange={(e) => handleConfigChange('economy_adventure_ticket_cost', parseInt(e.target.value) || 100)}
              min={0}
              max={1000000}
            />
          </div>
          <div>
            <Label>Max Scenes per Adventure</Label>
            <Input
              type="number"
              value={config?.economy_adventure_max_scenes ?? 10}
              onChange={(e) => handleConfigChange('economy_adventure_max_scenes', parseInt(e.target.value) || 10)}
              min={3}
              max={30}
            />
          </div>
        </div>
      </Card>

      {/* Adventure List */}
      {adventures.length === 0 ? (
        <EmptyState
          icon={Swords}
          title="No adventures yet"
          description="Create your first adventure to get started."
          action={{
            label: 'Create Adventure',
            onClick: () => setEditing({ ...BLANK_ADVENTURE }),
          }}
        />
      ) : (
        <div className="grid gap-3">
          {adventures.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 cursor-pointer" onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}>
                  <span className="text-2xl">{a.emoji}</span>
                  <div>
                    <p className="font-semibold">{a.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {TYPE_EMOJI[a.adventure_type] ?? '❓'} {a.adventure_type} • {a.difficulty} • {a.min_scenes}–{a.max_scenes} scenes
                    </p>
                  </div>
                  {expandedId === a.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(a)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(a.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
              {expandedId === a.id && a.description && (
                <p className="mt-2 text-sm text-muted-foreground">{a.description}</p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <Card className="p-6 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold">{editing.id ? 'Edit' : 'New'} Adventure</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </div>
                <div>
                  <Label>Emoji</Label>
                  <Input value={editing.emoji} onChange={(e) => setEditing({ ...editing, emoji: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Description</Label>
                <Textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={2} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Type</Label>
                  <Select value={editing.adventure_type} onValueChange={(v) => setEditing({ ...editing, adventure_type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{TYPE_EMOJI[t]} {t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Difficulty</Label>
                  <Select value={editing.difficulty} onValueChange={(v) => setEditing({ ...editing, difficulty: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DIFFICULTIES.map((d) => (
                        <SelectItem key={d} value={d}>{d.toUpperCase()}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Min Scenes</Label>
                  <Input type="number" value={editing.min_scenes} onChange={(e) => setEditing({ ...editing, min_scenes: parseInt(e.target.value) || 5 })} min={1} max={30} />
                </div>
                <div>
                  <Label>Max Scenes</Label>
                  <Input type="number" value={editing.max_scenes} onChange={(e) => setEditing({ ...editing, max_scenes: parseInt(e.target.value) || 10 })} min={1} max={30} />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={saveAdventure} disabled={saving || !editing.name}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Adventure"
        description="This will delete this adventure and all its scenes. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAdventure}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
