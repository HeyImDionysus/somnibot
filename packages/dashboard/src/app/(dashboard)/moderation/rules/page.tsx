/**
 * Auto-Mod Rules — Full CRUD for auto-mod rules.
 *
 * Architecture doc §18.2
 */
'use client';

import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';

interface AutoModRule {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  action: string;
  mute_duration_minutes: number | null;
  exempt_roles: string[];
  exempt_channels: string[];
  log_to_mod_channel: boolean;
  created_at: string;
}

const RULE_TYPES = [
  { value: 'word_filter', label: 'Word Filter', icon: '🚫', desc: 'Block banned words/phrases (exact, wildcard, or regex)' },
  { value: 'link_filter', label: 'Link Filter', icon: '🔗', desc: 'Whitelist or blacklist domains' },
  { value: 'invite_filter', label: 'Invite Filter', icon: '📨', desc: 'Block Discord invite links' },
  { value: 'spam_filter', label: 'Spam Filter', icon: '⚡', desc: 'Detect rapid message sending' },
  { value: 'duplicate_filter', label: 'Duplicate Filter', icon: '📋', desc: 'Detect repeated identical messages' },
  { value: 'caps_filter', label: 'Caps Filter', icon: '🔠', desc: 'Detect excessive uppercase text' },
  { value: 'mention_spam', label: 'Mention Spam', icon: '📢', desc: 'Detect excessive @mentions' },
  { value: 'newline_spam', label: 'Newline Spam', icon: '📜', desc: 'Detect excessive newlines (wall of text)' },
];

const ACTIONS = [
  { value: 'delete', label: 'Delete Only', color: 'text-blue-400' },
  { value: 'warn', label: 'Delete + Warn', color: 'text-yellow-400' },
  { value: 'mute', label: 'Delete + Mute', color: 'text-orange-400' },
  { value: 'kick', label: 'Delete + Kick', color: 'text-red-400' },
  { value: 'ban', label: 'Delete + Ban', color: 'text-red-500' },
];

function getDefaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'word_filter': return { words: [], matchMode: 'exact', caseSensitive: false };
    case 'link_filter': return { mode: 'blacklist', domains: [] };
    case 'invite_filter': return { allowOwnServer: false };
    case 'spam_filter': return { maxMessages: 5, intervalSeconds: 5 };
    case 'duplicate_filter': return { threshold: 3, intervalSeconds: 30 };
    case 'caps_filter': return { maxPercent: 70, minLength: 10 };
    case 'mention_spam': return { maxMentions: 5 };
    case 'newline_spam': return { maxNewlines: 15 };
    default: return {};
  }
}

export default function AutoModRulesPage() {
  const [rules, setRules] = useState<AutoModRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Partial<AutoModRule> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { toast } = useToast();

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch('/api/moderation/rules');
      const json = await res.json();
      if (json.success) {
        setRules(json.data);
      }
    } catch {
      setError('Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  useAutoRefresh('automod_rules', undefined, loadRules);

  const handleCreate = () => {
    setIsCreating(true);
    setEditingRule({
      name: '',
      type: 'word_filter',
      enabled: true,
      config: getDefaultConfig('word_filter'),
      action: 'warn',
      mute_duration_minutes: 5,
      exempt_roles: [],
      exempt_channels: [],
      log_to_mod_channel: true,
    });
  };

  const handleEdit = (rule: AutoModRule) => {
    setIsCreating(false);
    setEditingRule({ ...rule });
  };

  const handleSave = async () => {
    if (!editingRule) return;
    setSaving(true);
    setError(null);

    try {
      const method = isCreating ? 'POST' : 'PUT';
      const res = await fetch('/api/moderation/rules', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingRule),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setEditingRule(null);
      toast({ title: isCreating ? 'Rule created' : 'Rule updated', variant: 'success' });
      await loadRules();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save rule';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ruleId: string) => {
    try {
      const res = await fetch(`/api/moderation/rules?id=${ruleId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: 'Rule deleted', variant: 'success' });
      await loadRules();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete rule';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    }
  };

  const handleToggle = async (rule: AutoModRule) => {
    try {
      const res = await fetch('/api/moderation/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: rule.enabled ? 'Rule disabled' : 'Rule enabled', variant: 'success' });
      await loadRules();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to toggle rule';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    }
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Auto-Mod Rules</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Automated detection and action on rule violations.
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="rounded-md bg-somni-pink px-4 py-2 text-sm font-semibold text-white hover:bg-somni-pink/80"
        >
          + New Rule
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Rule List */}
      {rules.length === 0 && !editingRule && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-discord-border bg-discord-bg-secondary py-16">
          <span className="text-4xl">🛡️</span>
          <h3 className="mt-4 text-lg font-semibold text-discord-text-primary">No Rules Yet</h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            Create your first auto-mod rule to start protecting your server.
          </p>
          <button
            onClick={handleCreate}
            className="mt-4 rounded-md bg-somni-pink px-4 py-2 text-sm font-semibold text-white hover:bg-somni-pink/80"
          >
            Create Rule
          </button>
        </div>
      )}

      {rules.map((rule) => {
        const ruleType = RULE_TYPES.find((t) => t.value === rule.type);
        const actionInfo = ACTIONS.find((a) => a.value === rule.action);

        return (
          <div
            key={rule.id}
            className={`rounded-lg border bg-discord-bg-secondary p-4 ${
              rule.enabled ? 'border-discord-border' : 'border-discord-border/50 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span>{ruleType?.icon ?? '🛡️'}</span>
                  <h3 className="font-semibold text-discord-text-primary">{rule.name}</h3>
                  <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-muted">
                    {ruleType?.label ?? rule.type}
                  </span>
                  <span className={`text-xs font-medium ${actionInfo?.color ?? ''}`}>
                    {actionInfo?.label ?? rule.action}
                  </span>
                  {rule.action === 'mute' && rule.mute_duration_minutes && (
                    <span className="text-xs text-discord-text-muted">
                      ({rule.mute_duration_minutes}m)
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-discord-text-muted">
                  {ruleType?.desc ?? ''}
                </p>
                {/* Show config summary */}
                <ConfigSummary type={rule.type} config={rule.config} />
              </div>

              <div className="flex items-center gap-2">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={rule.enabled}
                    onChange={() => handleToggle(rule)}
                  />
                  <div className="peer h-5 w-9 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
                </label>
                <button
                  onClick={() => handleEdit(rule)}
                  className="rounded bg-discord-bg-tertiary px-3 py-1.5 text-xs text-discord-text-muted hover:text-discord-text-primary"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete(rule.id)}
                  className="rounded bg-discord-bg-tertiary px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Edit/Create Panel */}
      {editingRule && (
        <RuleEditor
          rule={editingRule}
          isCreating={isCreating}
          saving={saving}
          onChange={setEditingRule}
          onSave={handleSave}
          onCancel={() => setEditingRule(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Auto-Mod Rule"
        description="Are you sure you want to delete this rule? This action cannot be undone."
        confirmLabel="Delete Rule"
        variant="danger"
        onConfirm={() => {
          if (confirmDelete) handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

// ── Config Summary ──

function ConfigSummary({ type, config }: { type: string; config: Record<string, unknown> }) {
  const items: string[] = [];

  switch (type) {
    case 'word_filter': {
      const words = config.words as string[] ?? [];
      items.push(`${words.length} word(s)`, `Mode: ${config.matchMode ?? 'exact'}`);
      break;
    }
    case 'link_filter': {
      const domains = config.domains as string[] ?? [];
      items.push(`${config.mode ?? 'blacklist'}: ${domains.length} domain(s)`);
      break;
    }
    case 'spam_filter':
      items.push(`${config.maxMessages ?? 5} msgs in ${config.intervalSeconds ?? 5}s`);
      break;
    case 'duplicate_filter':
      items.push(`${config.threshold ?? 3} dupes in ${config.intervalSeconds ?? 30}s`);
      break;
    case 'caps_filter':
      items.push(`>${config.maxPercent ?? 70}% caps, min ${config.minLength ?? 10} chars`);
      break;
    case 'mention_spam':
      items.push(`Max ${config.maxMentions ?? 5} mentions`);
      break;
    case 'newline_spam':
      items.push(`Max ${config.maxNewlines ?? 15} newlines`);
      break;
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {items.map((item, i) => (
        <span key={i} className="rounded bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-muted">
          {item}
        </span>
      ))}
    </div>
  );
}

// ── Rule Editor ──

function RuleEditor({
  rule,
  isCreating,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  rule: Partial<AutoModRule>;
  isCreating: boolean;
  saving: boolean;
  onChange: (r: Partial<AutoModRule>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border-2 border-somni-pink/30 bg-discord-bg-secondary p-6">
      <h3 className="text-lg font-semibold text-discord-text-primary">
        {isCreating ? 'Create Rule' : 'Edit Rule'}
      </h3>

      <div className="mt-4 space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-discord-text-primary mb-1">Name</label>
          <input
            type="text"
            value={rule.name ?? ''}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder="e.g. Profanity Filter"
            className="w-full max-w-md rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-discord-text-primary mb-1">Rule Type</label>
          <select
            value={rule.type ?? 'word_filter'}
            onChange={(e) => {
              const newType = e.target.value;
              onChange({ ...rule, type: newType, config: getDefaultConfig(newType) });
            }}
            disabled={!isCreating}
            className="rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary disabled:opacity-50"
          >
            {RULE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
            ))}
          </select>
        </div>

        {/* Type-specific config */}
        <RuleConfig type={rule.type ?? 'word_filter'} config={rule.config ?? {}} onChange={(config) => onChange({ ...rule, config })} />

        {/* Action */}
        <div>
          <label className="block text-sm font-medium text-discord-text-primary mb-1">Action</label>
          <select
            value={rule.action ?? 'warn'}
            onChange={(e) => onChange({ ...rule, action: e.target.value })}
            className="rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>

        {/* Mute duration */}
        {rule.action === 'mute' && (
          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Mute Duration (minutes)</label>
            <input
              type="number"
              min={1}
              value={rule.mute_duration_minutes ?? 5}
              onChange={(e) => onChange({ ...rule, mute_duration_minutes: parseInt(e.target.value) || 5 })}
              className="w-24 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
            />
          </div>
        )}

        {/* Log to mod channel */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={rule.log_to_mod_channel ?? true}
            onChange={(e) => onChange({ ...rule, log_to_mod_channel: e.target.checked })}
            className="rounded"
          />
          <label className="text-sm text-discord-text-primary">Log to mod-log channel</label>
        </div>

        {/* Buttons */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={onSave}
            disabled={saving || !rule.name}
            className="rounded-md bg-somni-pink px-5 py-2 text-sm font-semibold text-white hover:bg-somni-pink/80 disabled:opacity-50"
          >
            {saving ? 'Saving...' : isCreating ? 'Create Rule' : 'Save Changes'}
          </button>
          <button
            onClick={onCancel}
            className="rounded-md bg-discord-bg-tertiary px-5 py-2 text-sm text-discord-text-muted hover:text-discord-text-primary"
          >
            Cancel
          </button>
        </div>
      </div>

    </div>
  );
}

// ── Type-specific config editors ──

function RuleConfig({
  type,
  config,
  onChange,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  switch (type) {
    case 'word_filter': {
      const words = (config.words as string[]) ?? [];
      const [newWord, setNewWord] = useState('');
      return (
        <div>
          <label className="block text-sm font-medium text-discord-text-primary mb-1">Banned Words</label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newWord.trim()) {
                  onChange({ ...config, words: [...words, newWord.trim()] });
                  setNewWord('');
                }
              }}
              placeholder="Type a word and press Enter"
              className="flex-1 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted"
            />
            <select
              value={(config.matchMode as string) ?? 'exact'}
              onChange={(e) => onChange({ ...config, matchMode: e.target.value })}
              className="rounded-md border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
            >
              <option value="exact">Exact</option>
              <option value="wildcard">Wildcard</option>
              <option value="regex">Regex</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-1">
            {words.map((w, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                {w}
                <button onClick={() => onChange({ ...config, words: words.filter((_, j) => j !== i) })} className="hover:text-white">×</button>
              </span>
            ))}
          </div>
        </div>
      );
    }

    case 'link_filter': {
      const domains = (config.domains as string[]) ?? [];
      const [newDomain, setNewDomain] = useState('');
      return (
        <div>
          <div className="flex gap-2 mb-2">
            <select
              value={(config.mode as string) ?? 'blacklist'}
              onChange={(e) => onChange({ ...config, mode: e.target.value })}
              className="rounded-md border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
            >
              <option value="blacklist">Blacklist (block these)</option>
              <option value="whitelist">Whitelist (only allow these)</option>
            </select>
          </div>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newDomain.trim()) {
                  onChange({ ...config, domains: [...domains, newDomain.trim()] });
                  setNewDomain('');
                }
              }}
              placeholder="example.com"
              className="flex-1 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {domains.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
                {d}
                <button onClick={() => onChange({ ...config, domains: domains.filter((_, j) => j !== i) })} className="hover:text-white">×</button>
              </span>
            ))}
          </div>
        </div>
      );
    }

    case 'invite_filter':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={(config.allowOwnServer as boolean) ?? false}
            onChange={(e) => onChange({ ...config, allowOwnServer: e.target.checked })}
            className="rounded"
          />
          <label className="text-sm text-discord-text-primary">Allow invites to this server</label>
        </div>
      );

    case 'spam_filter':
      return (
        <div className="flex items-center gap-2">
          <input
            type="number" min={2} value={(config.maxMessages as number) ?? 5}
            onChange={(e) => onChange({ ...config, maxMessages: parseInt(e.target.value) || 5 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
          <span className="text-sm text-discord-text-muted">messages in</span>
          <input
            type="number" min={1} value={(config.intervalSeconds as number) ?? 5}
            onChange={(e) => onChange({ ...config, intervalSeconds: parseInt(e.target.value) || 5 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
          <span className="text-sm text-discord-text-muted">seconds</span>
        </div>
      );

    case 'duplicate_filter':
      return (
        <div className="flex items-center gap-2">
          <input
            type="number" min={2} value={(config.threshold as number) ?? 3}
            onChange={(e) => onChange({ ...config, threshold: parseInt(e.target.value) || 3 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
          <span className="text-sm text-discord-text-muted">identical messages in</span>
          <input
            type="number" min={5} value={(config.intervalSeconds as number) ?? 30}
            onChange={(e) => onChange({ ...config, intervalSeconds: parseInt(e.target.value) || 30 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
          <span className="text-sm text-discord-text-muted">seconds</span>
        </div>
      );

    case 'caps_filter':
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-discord-text-muted">Trigger when &gt;</span>
            <input
              type="number" min={50} max={100} value={(config.maxPercent as number) ?? 70}
              onChange={(e) => onChange({ ...config, maxPercent: parseInt(e.target.value) || 70 })}
              className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
            />
            <span className="text-sm text-discord-text-muted">% uppercase</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-discord-text-muted">Minimum message length:</span>
            <input
              type="number" min={1} value={(config.minLength as number) ?? 10}
              onChange={(e) => onChange({ ...config, minLength: parseInt(e.target.value) || 10 })}
              className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
            />
          </div>
        </div>
      );

    case 'mention_spam':
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm text-discord-text-muted">Max mentions per message:</span>
          <input
            type="number" min={1} value={(config.maxMentions as number) ?? 5}
            onChange={(e) => onChange({ ...config, maxMentions: parseInt(e.target.value) || 5 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
        </div>
      );

    case 'newline_spam':
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm text-discord-text-muted">Max newlines per message:</span>
          <input
            type="number" min={5} value={(config.maxNewlines as number) ?? 15}
            onChange={(e) => onChange({ ...config, maxNewlines: parseInt(e.target.value) || 15 })}
            className="w-16 rounded border border-discord-border bg-discord-bg-tertiary px-2 py-1 text-sm text-discord-text-primary"
          />
        </div>
      );

    default:
      return null;
  }
}
