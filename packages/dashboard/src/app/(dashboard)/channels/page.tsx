'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChannelTreeEditor, type ChannelItem, type CategoryItem } from '@/components/channels/channel-tree-editor';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import { Badge } from '@/components/shared/badge';
import { channelsApi, type ChannelTemplateRow } from '@/lib/api/client';
import { Hash, Save, X, AlertTriangle, Plus } from 'lucide-react';

// ============================================================
// Types
// ============================================================

interface EditingChannel {
  id: string | null;
  name: string;
  type: 'text' | 'voice' | 'announcement' | 'forum' | 'stage';
  categoryId: string | null;
  topic: string;
  slowmode: number;
  nsfw: boolean;
  templateId: string;
}

interface EditingCategory {
  id: string | null;
  name: string;
}

// ============================================================
// Constants
// ============================================================

const CHANNEL_TYPE_OPTIONS = [
  { value: 'text', label: 'Text Channel' },
  { value: 'voice', label: 'Voice Channel' },
  { value: 'announcement', label: 'Announcement Channel' },
  { value: 'forum', label: 'Forum Channel' },
  { value: 'stage', label: 'Stage Channel' },
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

// Default categories for a new server
const DEFAULT_CATEGORIES: CategoryItem[] = [
  { id: 'cat-info', name: 'INFORMATION' },
  { id: 'cat-general', name: 'GENERAL' },
  { id: 'cat-community', name: 'COMMUNITY' },
  { id: 'cat-music', name: 'MUSIC' },
  { id: 'cat-voice', name: 'VOICE' },
  { id: 'cat-staff', name: 'STAFF' },
];

const DEFAULT_CHANNELS: ChannelItem[] = [
  { id: 'ch-rules', name: 'rules', type: 'text', categoryId: 'cat-info', templateName: 'member_view_only', topic: 'Server rules and guidelines', slowmode: 0, nsfw: false },
  { id: 'ch-announcements', name: 'announcements', type: 'announcement', categoryId: 'cat-info', templateName: 'member_view_only', topic: 'Important server announcements', slowmode: 0, nsfw: false },
  { id: 'ch-welcome', name: 'welcome', type: 'text', categoryId: 'cat-info', templateName: 'member_view_only', topic: 'Welcome messages for new members', slowmode: 0, nsfw: false },
  { id: 'ch-general', name: 'general', type: 'text', categoryId: 'cat-general', templateName: 'member_view_and_use', topic: 'General conversation', slowmode: 0, nsfw: false },
  { id: 'ch-media', name: 'media', type: 'text', categoryId: 'cat-general', templateName: 'member_view_and_use', topic: 'Share images, videos, and links', slowmode: 5, nsfw: false },
  { id: 'ch-bot-commands', name: 'bot-commands', type: 'text', categoryId: 'cat-general', templateName: 'member_view_and_use', topic: 'Use bot commands here', slowmode: 3, nsfw: false },
  { id: 'ch-lounge', name: 'lounge', type: 'text', categoryId: 'cat-community', templateName: 'member_view_and_use', topic: 'Chill and hang out', slowmode: 0, nsfw: false },
  { id: 'ch-music-chat', name: 'music-chat', type: 'text', categoryId: 'cat-music', templateName: 'member_view_and_use', topic: 'Discuss music and song requests', slowmode: 0, nsfw: false },
  { id: 'ch-now-playing', name: 'now-playing', type: 'text', categoryId: 'cat-music', templateName: 'member_view_only', topic: 'Currently playing tracks', slowmode: 0, nsfw: false },
  { id: 'ch-listening', name: 'Listening Room', type: 'voice', categoryId: 'cat-music', templateName: 'member_view_and_use', topic: '', slowmode: 0, nsfw: false },
  { id: 'ch-general-vc', name: 'General', type: 'voice', categoryId: 'cat-voice', templateName: 'member_view_and_use', topic: '', slowmode: 0, nsfw: false },
  { id: 'ch-gaming', name: 'Gaming', type: 'voice', categoryId: 'cat-voice', templateName: 'member_view_and_use', topic: '', slowmode: 0, nsfw: false },
  { id: 'ch-staff-chat', name: 'staff-chat', type: 'text', categoryId: 'cat-staff', templateName: 'staff_only', topic: 'Staff discussion', slowmode: 0, nsfw: false },
  { id: 'ch-mod-log', name: 'mod-log', type: 'text', categoryId: 'cat-staff', templateName: 'staff_only', topic: 'Moderation actions log', slowmode: 0, nsfw: false },
  { id: 'ch-bot-log', name: 'bot-log', type: 'text', categoryId: 'cat-staff', templateName: 'staff_only', topic: 'Bot activity log', slowmode: 0, nsfw: false },
];

// ============================================================
// Page
// ============================================================

export default function ChannelsPage() {
  const [categories, setCategories] = useState<CategoryItem[]>(DEFAULT_CATEGORIES);
  const [channels, setChannels] = useState<ChannelItem[]>(DEFAULT_CHANNELS);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [editingChannel, setEditingChannel] = useState<EditingChannel | null>(null);
  const [editingCategory, setEditingCategory] = useState<EditingCategory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  // Add channel
  const handleAddChannel = (categoryId: string | null) => {
    setEditingChannel({
      id: null,
      name: '',
      type: 'text',
      categoryId,
      topic: '',
      slowmode: 0,
      nsfw: false,
      templateId: 'member_view_and_use',
    });
    setEditingCategory(null);
  };

  // Add category
  const handleAddCategory = () => {
    setEditingCategory({ id: null, name: '' });
    setEditingChannel(null);
  };

  // Edit channel
  const handleEditChannel = (id: string) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return;
    setEditingChannel({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      categoryId: channel.categoryId,
      topic: channel.topic ?? '',
      slowmode: channel.slowmode,
      nsfw: channel.nsfw,
      templateId: channel.templateName,
    });
    setEditingCategory(null);
  };

  // Save channel
  const handleSaveChannel = () => {
    if (!editingChannel || !editingChannel.name) return;

    if (editingChannel.id) {
      setChannels((prev) =>
        prev.map((c) =>
          c.id === editingChannel.id
            ? {
                ...c,
                name: editingChannel.name,
                type: editingChannel.type,
                categoryId: editingChannel.categoryId,
                topic: editingChannel.topic,
                slowmode: editingChannel.slowmode,
                nsfw: editingChannel.nsfw,
                templateName: editingChannel.templateId,
              }
            : c,
        ),
      );
    } else {
      const newChannel: ChannelItem = {
        id: `ch-${Date.now()}`,
        name: editingChannel.name,
        type: editingChannel.type,
        categoryId: editingChannel.categoryId,
        templateName: editingChannel.templateId,
        topic: editingChannel.topic,
        slowmode: editingChannel.slowmode,
        nsfw: editingChannel.nsfw,
      };
      setChannels((prev) => [...prev, newChannel]);
    }

    setEditingChannel(null);
  };

  // Save category
  const handleSaveCategory = () => {
    if (!editingCategory || !editingCategory.name) return;

    if (editingCategory.id) {
      setCategories((prev) =>
        prev.map((c) => (c.id === editingCategory.id ? { ...c, name: editingCategory.name } : c)),
      );
    } else {
      setCategories((prev) => [...prev, { id: `cat-${Date.now()}`, name: editingCategory.name }]);
    }

    setEditingCategory(null);
  };

  // Delete channel
  const handleDeleteChannel = (id: string) => {
    setChannels((prev) => prev.filter((c) => c.id !== id));
    if (selectedChannelId === id) setSelectedChannelId(null);
  };

  // Delete category
  const handleDeleteCategory = (id: string) => {
    // Move channels out of category first
    setChannels((prev) =>
      prev.map((c) => (c.categoryId === id ? { ...c, categoryId: null } : c)),
    );
    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
          <Hash size={22} />
          Channel Structure
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Design your server&apos;s channel layout. Each channel uses a permission template that controls access.
        </p>
      </div>

      {/* Error */}
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
          <ChannelTreeEditor
            categories={categories}
            channels={channels}
            selectedChannelId={selectedChannelId}
            onSelectChannel={(id) => { setSelectedChannelId(id); handleEditChannel(id); }}
            onAddChannel={handleAddChannel}
            onAddCategory={handleAddCategory}
            onEditChannel={handleEditChannel}
            onDeleteChannel={handleDeleteChannel}
            onEditCategory={(id) => {
              const cat = categories.find((c) => c.id === id);
              if (cat) { setEditingCategory({ id: cat.id, name: cat.name }); setEditingChannel(null); }
            }}
            onDeleteCategory={handleDeleteCategory}
            onReorderChannels={setChannels}
          />
        </Card>

        {/* Right: Editor */}
        <Card>
          {editingChannel ? (
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>
                  {editingChannel.id ? `Edit: #${editingChannel.name}` : 'New Channel'}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditingChannel(null)}>Cancel</Button>
                  <Button size="sm" onClick={handleSaveChannel} disabled={!editingChannel.name}>
                    <Save size={12} />
                    Save
                  </Button>
                </div>
              </CardHeader>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Channel Name"
                  id="ch-name"
                  value={editingChannel.name}
                  onChange={(e) => setEditingChannel({ ...editingChannel, name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                  placeholder="e.g. general"
                />
                <Select
                  label="Type"
                  id="ch-type"
                  options={CHANNEL_TYPE_OPTIONS}
                  value={editingChannel.type}
                  onChange={(e) => setEditingChannel({ ...editingChannel, type: e.target.value as EditingChannel['type'] })}
                />
              </div>

              <Select
                label="Category"
                id="ch-category"
                options={[
                  { value: '', label: '— No category —' },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
                value={editingChannel.categoryId ?? ''}
                onChange={(e) => setEditingChannel({ ...editingChannel, categoryId: e.target.value || null })}
              />

              {editingChannel.type === 'text' && (
                <Input
                  label="Topic"
                  id="ch-topic"
                  value={editingChannel.topic}
                  onChange={(e) => setEditingChannel({ ...editingChannel, topic: e.target.value })}
                  placeholder="Channel topic description..."
                />
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  label="Slowmode"
                  id="ch-slowmode"
                  options={SLOWMODE_OPTIONS}
                  value={String(editingChannel.slowmode)}
                  onChange={(e) => setEditingChannel({ ...editingChannel, slowmode: parseInt(e.target.value) })}
                />
                <Select
                  label="Permission Template"
                  id="ch-template"
                  options={[
                    { value: 'member_view_only', label: 'View Only (members can read)' },
                    { value: 'member_view_and_use', label: 'View & Use (members can chat)' },
                    { value: 'staff_only', label: 'Staff Only (mod+ access)' },
                    { value: 'premium_only', label: 'Premium Only (subscriber access)' },
                  ]}
                  value={editingChannel.templateId}
                  onChange={(e) => setEditingChannel({ ...editingChannel, templateId: e.target.value })}
                />
              </div>

              <Toggle
                label="NSFW Channel"
                description="Members must confirm they are 18+ to view"
                checked={editingChannel.nsfw}
                onChange={(nsfw) => setEditingChannel({ ...editingChannel, nsfw })}
              />
            </div>
          ) : editingCategory ? (
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>
                  {editingCategory.id ? `Edit Category` : 'New Category'}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditingCategory(null)}>Cancel</Button>
                  <Button size="sm" onClick={handleSaveCategory} disabled={!editingCategory.name}>
                    <Save size={12} />
                    Save
                  </Button>
                </div>
              </CardHeader>
              <Input
                label="Category Name"
                id="cat-name"
                value={editingCategory.name}
                onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value.toUpperCase() })}
                placeholder="e.g. COMMUNITY"
              />
              <p className="text-xs text-discord-text-muted">
                Categories group channels together. They appear as collapsible sections in Discord.
              </p>
            </div>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Hash size={32} className="mb-2 text-discord-text-muted/30" />
              <p className="text-sm text-discord-text-muted">
                Select a channel to edit, or use the + buttons to create channels and categories.
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
          <Badge variant="success">{channels.filter((c) => c.type === 'text' || c.type === 'announcement' || c.type === 'forum').length} text</Badge>
          <Badge variant="cyan">{channels.filter((c) => c.type === 'voice' || c.type === 'stage').length} voice</Badge>
          <Badge variant="default">{channels.length} total channels</Badge>
          <div className="flex-1" />
          <Button variant="primary" size="sm">
            <Save size={12} />
            Save Structure
          </Button>
        </div>
      </Card>
    </div>
  );
}
