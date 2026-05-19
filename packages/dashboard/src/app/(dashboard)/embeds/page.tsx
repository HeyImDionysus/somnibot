/**
 * Embed Builder — visual editor with live preview for Discord embeds.
 *
 * Architecture doc §22
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface EmbedConfig {
  id: string;
  guild_id: string;
  name: string;
  title: string | null;
  description: string | null;
  color: number | null;
  fields: EmbedField[];
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  author_name: string | null;
  author_url: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
  use_components_v2: boolean;
  components_v2_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const emptyDraft = {
  name: '',
  title: '',
  description: '',
  color: '#5865f2',
  fields: [] as EmbedField[],
  image_url: '',
  thumbnail_url: '',
  footer_text: '',
  footer_icon_url: '',
  author_name: '',
  author_url: '',
  author_icon_url: '',
  include_timestamp: false,
};

function numToHex(n: number | null): string {
  if (n == null) return '#5865f2';
  return `#${n.toString(16).padStart(6, '0')}`;
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ── Main Component ────────────────────────────────────────

export default function EmbedBuilderPage() {
  const { toast } = useToast();

  const [embeds, setEmbeds] = useState<EmbedConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState(emptyDraft);


  const fetchEmbeds = useCallback(async () => {
    try {
      const res = await fetch('/api/embeds');
      const json = await res.json();
      if (json.success) setEmbeds(json.data);
      else setError(json.error);
    } catch {
      setError('Failed to load embeds');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEmbeds();
  }, [fetchEmbeds]);

  const openEditor = (embed?: EmbedConfig) => {
    if (embed) {
      setEditingId(embed.id);
      setDraft({
        name: embed.name,
        title: embed.title ?? '',
        description: embed.description ?? '',
        color: numToHex(embed.color),
        fields: embed.fields ?? [],
        image_url: embed.image_url ?? '',
        thumbnail_url: embed.thumbnail_url ?? '',
        footer_text: embed.footer_text ?? '',
        footer_icon_url: embed.footer_icon_url ?? '',
        author_name: embed.author_name ?? '',
        author_url: embed.author_url ?? '',
        author_icon_url: embed.author_icon_url ?? '',
        include_timestamp: embed.include_timestamp,
      });
    } else {
      setEditingId(null);
      setDraft({ ...emptyDraft, fields: [] });
    }
    setShowEditor(true);
  };

  const addField = () => {
    if (draft.fields.length >= 25) return;
    setDraft({ ...draft, fields: [...draft.fields, { name: '', value: '', inline: false }] });
  };

  const updateField = (index: number, updates: Partial<EmbedField>) => {
    const newFields = [...draft.fields];
    newFields[index] = { ...newFields[index], ...updates };
    setDraft({ ...draft, fields: newFields });
  };

  const removeField = (index: number) => {
    setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) });
  };

  const save = async () => {
    setError(null);
    if (!draft.name) {
      setError('Embed name is required');
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      name: draft.name,
      title: draft.title || null,
      description: draft.description || null,
      color: draft.color ? hexToNum(draft.color) : null,
      fields: draft.fields.filter((f) => f.name || f.value),
      image_url: draft.image_url || null,
      thumbnail_url: draft.thumbnail_url || null,
      footer_text: draft.footer_text || null,
      footer_icon_url: draft.footer_icon_url || null,
      author_name: draft.author_name || null,
      author_url: draft.author_url || null,
      author_icon_url: draft.author_icon_url || null,
      include_timestamp: draft.include_timestamp,
    };

    try {
      const res = await fetch('/api/embeds', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setEmbeds(embeds.map((e) => (e.id === editingId ? json.data : e)));
        } else {
          setEmbeds([json.data, ...embeds]);
        }
        setShowEditor(false);
        toast({ title: editingId ? 'Embed updated' : 'Embed saved', variant: 'success' });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save embed');
    }
  };

  const deleteEmbed = async (id: string) => {
    try {
      const res = await fetch(`/api/embeds?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setEmbeds(embeds.filter((e) => e.id !== id));
        toast({ title: 'Embed deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete embed');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-discord-text-muted">Loading embed templates…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Embed Builder</h1>
          <p className="text-sm text-discord-text-muted">Create and manage reusable Discord embed templates</p>
        </div>
        <button
          onClick={() => openEditor()}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard"
        >
          + New Embed
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      {/* ── Editor with Preview ────────────────────────── */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 pt-8 pb-8">
          <div className="w-full max-w-5xl rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Embed' : 'New Embed'}
            </h2>
            <div className="grid gap-6 lg:grid-cols-2">
              {/* ── Form Side ──────────────────────────── */}
              <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Template Name *</label>
                  <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="My embed template"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>

                {/* Author */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Author Name</label>
                    <input type="text" value={draft.author_name} onChange={(e) => setDraft({ ...draft, author_name: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Author Icon URL</label>
                    <input type="text" value={draft.author_icon_url} onChange={(e) => setDraft({ ...draft, author_icon_url: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                </div>

                {/* Title & Color */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Title</label>
                    <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Color</label>
                    <div className="flex gap-2">
                      <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                        className="h-9 w-12 cursor-pointer rounded-input border border-discord-border-subtle" />
                      <input type="text" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                        className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                    </div>
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Description</label>
                  <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={4} placeholder="Embed description — supports markdown"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none" />
                </div>

                {/* Fields */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-discord-text-muted">Fields ({draft.fields.length}/25)</label>
                    <button onClick={addField} disabled={draft.fields.length >= 25}
                      className="rounded-input bg-discord-bg-tertiary px-2 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard disabled:opacity-50">
                      + Add Field
                    </button>
                  </div>
                  <div className="space-y-2">
                    {draft.fields.map((field, i) => (
                      <div key={i} className="rounded-input border border-discord-border-subtle bg-discord-bg-tertiary p-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <input type="text" value={field.name} onChange={(e) => updateField(i, { name: e.target.value })} placeholder="Field name"
                            className="rounded-input bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                          <div className="flex gap-2">
                            <label className="flex items-center gap-1 text-xs text-discord-text-muted cursor-pointer">
                              <input type="checkbox" checked={field.inline} onChange={(e) => updateField(i, { inline: e.target.checked })} className="rounded" />
                              Inline
                            </label>
                            <button onClick={() => removeField(i)} className="text-discord-danger text-xs">×</button>
                          </div>
                        </div>
                        <textarea value={field.value} onChange={(e) => updateField(i, { value: e.target.value })} placeholder="Field value" rows={1}
                          className="mt-2 w-full rounded-input bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none" />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Images */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Image URL</label>
                    <input type="text" value={draft.image_url} onChange={(e) => setDraft({ ...draft, image_url: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Thumbnail URL</label>
                    <input type="text" value={draft.thumbnail_url} onChange={(e) => setDraft({ ...draft, thumbnail_url: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                </div>

                {/* Footer */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-discord-text-muted">Footer Text</label>
                    <input type="text" value={draft.footer_text} onChange={(e) => setDraft({ ...draft, footer_text: e.target.value })}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                      <input type="checkbox" checked={draft.include_timestamp} onChange={(e) => setDraft({ ...draft, include_timestamp: e.target.checked })} className="rounded" />
                      Include timestamp
                    </label>
                  </div>
                </div>
              </div>

              {/* ── Preview Side ───────────────────────── */}
              <div className="rounded-card bg-discord-bg-tertiary p-4">
                <p className="text-xs font-medium text-discord-text-muted mb-3 uppercase tracking-wide">Live Preview</p>
                <div className="rounded-input overflow-hidden" style={{ borderLeft: `4px solid ${draft.color || '#5865f2'}` }}>
                  <div className="bg-discord-bg-floating p-4">
                    {/* Author */}
                    {draft.author_name && (
                      <div className="flex items-center gap-2 mb-2">
                        {draft.author_icon_url && (
                          <img src={draft.author_icon_url} alt="" className="h-6 w-6 rounded-full" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        )}
                        <span className="text-xs font-medium text-discord-text-primary">{draft.author_name}</span>
                      </div>
                    )}

                    {/* Title */}
                    {draft.title && (
                      <p className="text-base font-semibold text-discord-accent mb-1">{draft.title}</p>
                    )}

                    {/* Description */}
                    {draft.description && (
                      <p className="text-sm text-discord-text-secondary whitespace-pre-wrap mb-2">{draft.description}</p>
                    )}

                    {/* Fields */}
                    {draft.fields.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {draft.fields.map((f, i) => (
                          <div key={i} className={f.inline ? 'col-span-1' : 'col-span-3'}>
                            <p className="text-xs font-semibold text-discord-text-primary">{f.name || '\u200b'}</p>
                            <p className="text-sm text-discord-text-secondary">{f.value || '\u200b'}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Image */}
                    {draft.image_url && (
                      <img src={draft.image_url} alt="" className="mt-3 max-w-full rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    )}

                    {/* Footer */}
                    {(draft.footer_text || draft.include_timestamp) && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-discord-text-muted">
                        {draft.footer_text && <span>{draft.footer_text}</span>}
                        {draft.footer_text && draft.include_timestamp && <span>•</span>}
                        {draft.include_timestamp && <span>{new Date().toLocaleDateString()}</span>}
                      </div>
                    )}

                    {/* Thumbnail */}
                    {draft.thumbnail_url && (
                      <div className="absolute top-4 right-4">
                        <img src={draft.thumbnail_url} alt="" className="h-16 w-16 rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Empty state */}
                {!draft.title && !draft.description && draft.fields.length === 0 && (
                  <p className="mt-4 text-center text-xs text-discord-text-muted">
                    Start filling in the form to see a live preview
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowEditor(false)} className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard">
                Cancel
              </button>
              <button onClick={save} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                {editingId ? 'Update' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Embed List ─────────────────────────────────── */}
      {embeds.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">📋</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Embed Templates</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create your first embed template to get started.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Embed
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {embeds.map((embed) => (
            <div key={embed.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 hover:border-discord-accent/50 transition-standard">
              {/* Color bar */}
              <div
                className="h-1 w-full rounded-full mb-3"
                style={{ backgroundColor: numToHex(embed.color) }}
              />
              <h3 className="text-sm font-semibold text-discord-text-primary truncate">{embed.name}</h3>
              {embed.title && (
                <p className="text-xs text-discord-accent truncate mt-1">{embed.title}</p>
              )}
              {embed.description && (
                <p className="text-xs text-discord-text-muted mt-1 line-clamp-2">{embed.description}</p>
              )}
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-discord-text-muted">
                  {embed.fields?.length || 0} fields
                </span>
                <div className="flex gap-2">
                  <button onClick={() => openEditor(embed)} className="text-discord-text-muted hover:text-discord-accent text-xs transition-standard">
                    Edit
                  </button>
                  <button onClick={() => setConfirmDelete({ id: embed.id, name: embed.name })} className="text-discord-text-muted hover:text-discord-danger text-xs transition-standard">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Embed"
        description={`Delete "${confirmDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteEmbed(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
