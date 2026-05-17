'use client';

import { cn } from '@/lib/utils/cn';
import {
  Hash, Volume2, Megaphone, ChevronDown, ChevronRight,
  GripVertical, Pencil, Trash2, Plus, FolderOpen,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/shared/badge';
import { Button } from '@/components/shared/button';

// ============================================================
// Types
// ============================================================

export interface ChannelItem {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'announcement' | 'forum' | 'stage';
  categoryId: string | null;
  templateName: string;
  topic?: string;
  slowmode: number;
  nsfw: boolean;
}

export interface CategoryItem {
  id: string;
  name: string;
  collapsed?: boolean;
}

interface ChannelTreeEditorProps {
  categories: CategoryItem[];
  channels: ChannelItem[];
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onAddChannel: (categoryId: string | null) => void;
  onAddCategory: () => void;
  onEditChannel: (id: string) => void;
  onDeleteChannel: (id: string) => void;
  onEditCategory: (id: string) => void;
  onDeleteCategory: (id: string) => void;
  onReorderChannels: (channels: ChannelItem[]) => void;
}

// ============================================================
// Icons
// ============================================================

const channelIcons: Record<string, React.ElementType> = {
  text: Hash,
  voice: Volume2,
  announcement: Megaphone,
  forum: Hash,
  stage: Volume2,
};

// ============================================================
// Component
// ============================================================

export function ChannelTreeEditor({
  categories,
  channels,
  selectedChannelId,
  onSelectChannel,
  onAddChannel,
  onAddCategory,
  onEditChannel,
  onDeleteChannel,
  onEditCategory,
  onDeleteCategory,
}: ChannelTreeEditorProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  // Channels without a category
  const uncategorizedChannels = channels.filter((c) => !c.categoryId);

  return (
    <div className="space-y-0.5">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-2">
          <FolderOpen size={14} className="text-discord-text-muted" />
          <span className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
            Channel Structure
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onAddCategory}>
            <Plus size={14} />
            Category
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAddChannel(null)}>
            <Plus size={14} />
            Channel
          </Button>
        </div>
      </div>

      {/* Uncategorized channels */}
      {uncategorizedChannels.map((channel) => (
        <ChannelRow
          key={channel.id}
          channel={channel}
          isSelected={selectedChannelId === channel.id}
          onSelect={onSelectChannel}
          onEdit={onEditChannel}
          onDelete={onDeleteChannel}
        />
      ))}

      {/* Categories with children */}
      {categories.map((category) => {
        const isCollapsed = collapsedCategories.has(category.id);
        const categoryChannels = channels.filter((c) => c.categoryId === category.id);

        return (
          <div key={category.id}>
            {/* Category header */}
            <div className="group flex items-center gap-1 px-1 py-1">
              <button
                onClick={() => toggleCategory(category.id)}
                className="shrink-0 text-discord-text-muted hover:text-discord-text-primary"
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              <span className="flex-1 text-[11px] font-bold uppercase tracking-wider text-discord-text-muted">
                {category.name}
              </span>
              <span className="text-[10px] text-discord-text-muted/50">
                {categoryChannels.length}
              </span>
              <div className="flex items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
                <button
                  onClick={() => onAddChannel(category.id)}
                  className="rounded p-0.5 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
                  title="Add channel"
                >
                  <Plus size={11} />
                </button>
                <button
                  onClick={() => onEditCategory(category.id)}
                  className="rounded p-0.5 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
                  title="Edit category"
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => onDeleteCategory(category.id)}
                  className="rounded p-0.5 text-discord-text-muted hover:bg-discord-danger/20 hover:text-discord-danger"
                  title="Delete category"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>

            {/* Category channels */}
            {!isCollapsed && (
              <div className="pl-3">
                {categoryChannels.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-discord-text-muted/50 italic">
                    No channels — click + to add
                  </div>
                ) : (
                  categoryChannels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      isSelected={selectedChannelId === channel.id}
                      onSelect={onSelectChannel}
                      onEdit={onEditChannel}
                      onDelete={onDeleteChannel}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Channel Row
// ============================================================

function ChannelRow({
  channel,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: {
  channel: ChannelItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const Icon = channelIcons[channel.type] ?? Hash;

  return (
    <div
      onClick={() => onSelect(channel.id)}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 rounded-input px-2 py-1 transition-standard',
        isSelected
          ? 'bg-discord-accent/15 text-discord-text-primary ring-1 ring-discord-accent/40'
          : 'text-discord-text-muted hover:bg-discord-bg-primary/50 hover:text-discord-text-primary',
      )}
    >
      <GripVertical
        size={12}
        className="shrink-0 cursor-grab text-discord-text-muted/30 active:cursor-grabbing group-hover:text-discord-text-muted/60"
      />
      <Icon size={14} className="shrink-0" />
      <span className="flex-1 truncate text-sm">{channel.name}</span>

      {channel.nsfw && <Badge variant="danger">nsfw</Badge>}
      {channel.slowmode > 0 && <Badge variant="default">{channel.slowmode}s</Badge>}

      <Badge variant="default">{channel.templateName}</Badge>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(channel.id); }}
          className="rounded p-0.5 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(channel.id); }}
          className="rounded p-0.5 text-discord-text-muted hover:bg-discord-danger/20 hover:text-discord-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
