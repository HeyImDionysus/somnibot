'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import { Badge } from '@/components/shared/badge';
import { channelsApi, type LiveChannelData, type LiveCategoryData } from '@/lib/api/client';
import {
  Hash, Volume2, Megaphone, MessageSquare, Radio,
  FolderOpen, Plus, Pencil, Trash2, RefreshCw, AlertTriangle,
  X, Save, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';

// ============================================================
// Constants
// ============================================================

/** Discord ChannelType enum values */
const CHANNEL_TYPE_LABELS: Record<number, { label: string; icon: typeof Hash }> = {
  0:  { label: 'Text',         icon: Hash },
  2:  { label: 'Voice',        icon: Volume2 },
  5:  { label: 'Announcement', icon: Megaphone },
  13: { label: 'Stage',        icon: Radio },
  15: { label: 'Forum',        icon: MessageSquare },
};

const CHANNEL_TYPE_OPTIONS = [
  { value: '0',  label: 'Text Channel' },
  { value: '2',  label: 'Voice Channel' },
  { value: '5',  label: 'Announcement' },
  { value: '13', label: 'Stage Channel' },
  { value: '15', label: 'Forum Channel' },
];

const SLOWMODE_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 seconds' },
  { value: '10', label: '10 seconds' },
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '21600', label: '6 hours' },
];

function getChannelIcon(type: number) {
  return CHANNEL_TYPE_LABELS[type]?.icon ?? Hash;
}

// ============================================================
// Types
// ============================================================

interface NewChannelForm {
  name: string;
  type: number;
  parentId: string | null;
  topic: string;
  slowmode: number;
  nsfw: boolean;
  isCategory: boolean;
}

// ============================================================
// Page
// ============================================================

export default function ChannelsPage() {
  const { toast } = useToast();
  const [confirmAction, setConfirmAction] = useState<{ type: 'channel' | 'category'; id: string; name: string } | null>(null);

  const [channels, setChannels] = useState<LiveChannelData[]>([]);
  const [categories, setCategories] = useState<LiveCategoryData[]>([]);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [awaitingSnapshot, setAwaitingSnapshot] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingChannel, setEditingChannel] = useState<LiveChannelData | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewChannelForm>({
    name: '', type: 0, parentId: null, topic: '', slowmode: 0, nsfw: false, isCategory: false,
  });
  const [actionPending, setActionPending] = useState(false);

  // ── Load channels from live state ──
  const loadChannels = useCallback(async () => {
    try {
      setLoading(true);
      const response = await channelsApi.list();
      setChannels(response.channels);
      setCategories(response.categories);
      setSnapshotAt(response.snapshotAt);
      setAwaitingSnapshot(response.awaitingSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  // ── Group channels by category ──
  const uncategorized = channels.filter((c) => !c.parentId);
  const channelsByCategory = new Map<string, LiveChannelData[]>();
  for (const cat of categories) {
    channelsByCategory.set(cat.id, channels.filter((c) => c.parentId === cat.id));
  }

  // ── Toggle category collapse ──
  const toggleCategory = (id: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Create channel/category ──
  const handleCreate = async () => {
    if (!newForm.name) return;
    setActionPending(true);
    try {
      await channelsApi.create({
        name: newForm.isCategory ? newForm.name.toUpperCase() : newForm.name.toLowerCase().replace(/\s+/g, '-'),
        type: newForm.type,
        parentId: newForm.parentId,
        topic: newForm.topic || null,
        nsfw: newForm.nsfw,
        slowmode: newForm.slowmode,
        isCategory: newForm.isCategory,
      });
      setShowNewForm(false);
      setNewForm({ name: '', type: 0, parentId: null, topic: '', slowmode: 0, nsfw: false, isCategory: false });
      setTimeout(loadChannels, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setActionPending(false);
    }
  };

  // ── Update channel ──
  const handleUpdate = async () => {
    if (!editingChannel) return;
    setActionPending(true);
    try {
      await channelsApi.update({
        channelId: editingChannel.id,
        name: editingChannel.name,
        topic: editingChannel.topic ?? undefined,
        nsfw: editingChannel.nsfw,
        slowmode: editingChannel.slowmode,
        parentId: editingChannel.parentId,
      });
      setEditingChannel(null);
      setTimeout(loadChannels, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setActionPending(false);
    }
  };

  // ── Delete channel ──
  const handleDeleteChannel = async (id: string, name: string) => {
    setActionPending(true);
    try {
      await channelsApi.deleteChannel(id);
      if (selectedId === id) { setSelectedId(null); setEditingChannel(null); }
      setTimeout(loadChannels, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setActionPending(false);
    }
  };

  // ── Delete category ──
  const handleDeleteCategory = async (id: string, name: string) => {
    setActionPending(true);
    try {
      await channelsApi.deleteCategory(id);
      setTimeout(loadChannels, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
    } finally {
      setActionPending(false);
    }
  };

  // ── Select channel for editing ──
  const selectChannel = (channel: LiveChannelData) => {
    setSelectedId(channel.id);
    setEditingChannel({ ...channel });
    setShowNewForm(false);
  };

  // ── Channel row ──
  const ChannelRow = ({ channel }: { channel: LiveChannelData }) => {
    const Icon = getChannelIcon(channel.type);
    return (
      <div
        onClick={() => selectChannel(channel)}
        className={cn(
          'group flex cursor-pointer items-center gap-2 rounded-input px-3 py-1.5 transition-standard',
          selectedId === channel.id
            ? 'bg-discord-accent/15 ring-1 ring-discord-accent/40'
            : 'hover:bg-discord-bg-primary/50',
        )}
      >
        <Icon size={14} className="shrink-0 text-discord-text-muted" />
        <span className="flex-1 truncate text-sm text-discord-text-primary">
          {channel.name}
        </span>
        {channel.nsfw && <Badge variant="danger">NSFW</Badge>}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
          <button
            onClick={(e) => { e.stopPropagation(); selectChannel(channel); }}
            className="rounded p-1 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'channel', id: channel.id, name: channel.name }); }}
            className="rounded p-1 text-discord-text-muted hover:bg-discord-danger/20 hover:text-discord-danger"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  };

  // ── Loading state ──
  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
            <Hash size={22} />
            Channel Structure
          </h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Manage your server&apos;s channels and categories. All changes are applied directly to Discord.
          </p>
          {snapshotAt && (
            <p className="mt-0.5 text-xs text-discord-text-muted">
              Last synced: {new Date(snapshotAt).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={loadChannels} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowNewForm(true);
              setEditingChannel(null);
              setSelectedId(null);
              setNewForm({ ...newForm, isCategory: true, name: '' });
            }}
          >
            <FolderOpen size={14} />
            Add Category
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setShowNewForm(true);
              setEditingChannel(null);
              setSelectedId(null);
              setNewForm({ ...newForm, isCategory: false, name: '' });
            }}
          >
            <Plus size={14} />
            Add Channel
          </Button>
        </div>
      </div>

      {/* Warnings */}
      {awaitingSnapshot && (
        <Card variant="warning">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-discord-warning" />
            <p className="text-sm text-discord-warning">
              Waiting for the bot to send its first snapshot. Make sure the bot is online.
            </p>
          </div>
        </Card>
      )}

      {error && (
        <Card variant="danger">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-discord-danger" />
            <p className="text-sm text-discord-danger">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        {/* Left: Channel tree */}
        <Card>
          <div className="space-y-0.5">
            {/* Uncategorized channels */}
            {uncategorized.length > 0 && (
              <div className="space-y-0.5 pb-2">
                {uncategorized.map((ch) => <ChannelRow key={ch.id} channel={ch} />)}
              </div>
            )}

            {/* Categories with children */}
            {categories.map((cat) => {
              const isCollapsed = collapsedCategories.has(cat.id);
              const children = channelsByCategory.get(cat.id) ?? [];
              return (
                <div key={cat.id}>
                  {/* Category header */}
                  <div
                    onClick={() => toggleCategory(cat.id)}
                    className="group flex cursor-pointer items-center gap-1 px-1 py-1 hover:text-discord-text-primary"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} className="text-discord-text-muted" />
                    ) : (
                      <ChevronDown size={12} className="text-discord-text-muted" />
                    )}
                    <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-discord-text-muted group-hover:text-discord-text-primary">
                      {cat.name}
                    </span>
                    <span className="text-[10px] text-discord-text-muted">{children.length}</span>
                    <div className="flex items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowNewForm(true);
                          setEditingChannel(null);
                          setSelectedId(null);
                          setNewForm({ ...newForm, isCategory: false, parentId: cat.id, name: '' });
                        }}
                        className="rounded p-0.5 text-discord-text-muted hover:text-discord-text-primary"
                        title="Add channel to this category"
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmAction({ type: 'category', id: cat.id, name: cat.name });
                        }}
                        className="rounded p-0.5 text-discord-text-muted hover:text-discord-danger"
                        title="Delete category"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Category children */}
                  {!isCollapsed && (
                    <div className="ml-3 space-y-0.5 border-l border-discord-border-subtle pl-2">
                      {children.length > 0 ? (
                        children.map((ch) => <ChannelRow key={ch.id} channel={ch} />)
                      ) : (
                        <p className="py-1 text-xs italic text-discord-text-muted/50 pl-2">
                          Empty category
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {channels.length === 0 && categories.length === 0 && !awaitingSnapshot && (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-discord-text-muted">No channels found</p>
              </div>
            )}
          </div>
        </Card>

        {/* Right: Editor */}
        <Card>
          {showNewForm ? (
            /* ── New channel/category form ── */
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>
                  {newForm.isCategory ? 'New Category' : 'New Channel'}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowNewForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={handleCreate} disabled={!newForm.name || actionPending}>
                    <Plus size={12} />
                    {actionPending ? 'Creating...' : 'Create'}
                  </Button>
                </div>
              </CardHeader>

              <Input
                label={newForm.isCategory ? 'Category Name' : 'Channel Name'}
                id="new-name"
                value={newForm.name}
                onChange={(e) => setNewForm({
                  ...newForm,
                  name: newForm.isCategory
                    ? e.target.value.toUpperCase()
                    : e.target.value.toLowerCase().replace(/\s+/g, '-'),
                })}
                placeholder={newForm.isCategory ? 'e.g. COMMUNITY' : 'e.g. general'}
              />

              {!newForm.isCategory && (
                <>
                  <Select
                    label="Channel Type"
                    id="new-type"
                    options={CHANNEL_TYPE_OPTIONS}
                    value={String(newForm.type)}
                    onChange={(e) => setNewForm({ ...newForm, type: parseInt(e.target.value) })}
                  />

                  <Select
                    label="Category"
                    id="new-category"
                    options={[
                      { value: '', label: '— No category —' },
                      ...categories.map((c) => ({ value: c.id, label: c.name })),
                    ]}
                    value={newForm.parentId ?? ''}
                    onChange={(e) => setNewForm({ ...newForm, parentId: e.target.value || null })}
                  />

                  {newForm.type === 0 && (
                    <Input
                      label="Topic"
                      id="new-topic"
                      value={newForm.topic}
                      onChange={(e) => setNewForm({ ...newForm, topic: e.target.value })}
                      placeholder="Channel topic description..."
                    />
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Select
                      label="Slowmode"
                      id="new-slowmode"
                      options={SLOWMODE_OPTIONS}
                      value={String(newForm.slowmode)}
                      onChange={(e) => setNewForm({ ...newForm, slowmode: parseInt(e.target.value) })}
                    />
                  </div>

                  <Toggle
                    label="NSFW Channel"
                    description="Members must confirm they are 18+ to view"
                    checked={newForm.nsfw}
                    onChange={(nsfw) => setNewForm({ ...newForm, nsfw })}
                  />
                </>
              )}
            </div>
          ) : editingChannel ? (
            /* ── Edit channel ── */
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>
                  <div className="flex items-center gap-2">
                    {(() => { const Icon = getChannelIcon(editingChannel.type); return <Icon size={16} />; })()}
                    Edit: {editingChannel.name}
                  </div>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setEditingChannel(null); setSelectedId(null); }}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleUpdate} disabled={actionPending}>
                    <Save size={12} />
                    {actionPending ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </CardHeader>

              <Input
                label="Channel Name"
                id="edit-name"
                value={editingChannel.name}
                onChange={(e) => setEditingChannel({
                  ...editingChannel,
                  name: e.target.value.toLowerCase().replace(/\s+/g, '-'),
                })}
              />

              <div className="rounded-input bg-discord-bg-primary p-3">
                <p className="text-xs text-discord-text-muted">
                  Type: <span className="font-medium text-discord-text-primary">
                    {CHANNEL_TYPE_LABELS[editingChannel.type]?.label ?? 'Unknown'}
                  </span>
                  {' '}(cannot be changed after creation)
                </p>
              </div>

              <Select
                label="Category"
                id="edit-category"
                options={[
                  { value: '', label: '— No category —' },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
                value={editingChannel.parentId ?? ''}
                onChange={(e) => setEditingChannel({
                  ...editingChannel,
                  parentId: e.target.value || null,
                })}
              />

              {(editingChannel.type === 0 || editingChannel.type === 5) && (
                <Input
                  label="Topic"
                  id="edit-topic"
                  value={editingChannel.topic ?? ''}
                  onChange={(e) => setEditingChannel({
                    ...editingChannel,
                    topic: e.target.value,
                  })}
                  placeholder="Channel topic description..."
                />
              )}

              <Select
                label="Slowmode"
                id="edit-slowmode"
                options={SLOWMODE_OPTIONS}
                value={String(editingChannel.slowmode)}
                onChange={(e) => setEditingChannel({
                  ...editingChannel,
                  slowmode: parseInt(e.target.value),
                })}
              />

              <Toggle
                label="NSFW Channel"
                description="Members must confirm they are 18+ to view"
                checked={editingChannel.nsfw}
                onChange={(nsfw) => setEditingChannel({ ...editingChannel, nsfw })}
              />
            </div>
          ) : (
            /* ── Empty state ── */
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Hash size={32} className="mb-2 text-discord-text-muted/30" />
              <p className="text-sm text-discord-text-muted">
                Select a channel to edit, or create a new channel or category.
              </p>
              <CardDescription>
                {channels.length} channels across {categories.length} categories
              </CardDescription>
            </div>
          )}
        </Card>
      </div>

      {/* Summary bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="info">{categories.length} categories</Badge>
          <Badge variant="success">
            {channels.filter((c) => c.type === 0 || c.type === 5 || c.type === 15).length} text
          </Badge>
          <Badge variant="cyan">
            {channels.filter((c) => c.type === 2 || c.type === 13).length} voice
          </Badge>
          <Badge variant="default">{channels.length} total channels</Badge>
        </div>
      </Card>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.type === 'channel' ? 'Delete Channel' : 'Delete Category'}
        description={confirmAction?.type === 'channel'
          ? `Delete channel #${confirmAction?.name}? This cannot be undone.`
          : `Delete category "${confirmAction?.name}"? Channels inside it will become uncategorized.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmAction) {
            if (confirmAction.type === 'channel') {
              await handleDeleteChannel(confirmAction.id, confirmAction.name);
            } else {
              await handleDeleteCategory(confirmAction.id, confirmAction.name);
            }
            setConfirmAction(null);
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
