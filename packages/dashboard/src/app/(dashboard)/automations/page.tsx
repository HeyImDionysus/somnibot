/**
 * Automations — Visual automation builder + execution log.
 *
 * Architecture doc §20
 */
'use client';

import { VariableChips } from '@/components/shared/variable-chips';
import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface AutomationCondition {
  type: string;
  config: Record<string, unknown>;
}

interface AutomationAction {
  type: string;
  config: Record<string, unknown>;
}

interface Automation {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  enabled: boolean;
  target_user_ids: string[];
  target_channel_ids: string[];
  exclude_user_ids: string[];
  exclude_channel_ids: string[];
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
}

interface Execution {
  id: string;
  automation_id: string;
  triggered_by: string;
  trigger_event: string;
  conditions_passed: boolean;
  actions_executed: number;
  actions_failed: number;
  errors: string[];
  duration_ms: number;
  created_at: string;
}

interface MassActionHold {
  id: string;
  automation_id: string;
  status: 'held' | 'approved' | 'executing' | 'failed';
  member_count: number;
  threshold: number;
  trigger_event: string;
  approved_by: string | null;
  last_error: string | null;
  created_at: string;
}

interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

// ── Metadata ──────────────────────────────────────────────

const TRIGGER_META: Record<string, { label: string; icon: string; description: string; variables: string[] }> = {
  'member.joined': { label: 'Member Joins', icon: '👋', description: 'When a new member joins', variables: ['{user}', '{memberCount}', '{returning}'] },
  'member.left': { label: 'Member Leaves', icon: '👋', description: 'When a member leaves', variables: ['{user}', '{memberCount}'] },
  'member.verified': { label: 'Member Verified', icon: '✅', description: 'When onboarding completes', variables: ['{user}', '{memberNumber}'] },
  'message.sent': { label: 'Sends a Message', icon: '💬', description: 'When a member sends a message', variables: ['{user}', '{channel}', '{content}'] },
  'role.gained': { label: 'Gains a Role', icon: '🏷️', description: 'When a member gains a role', variables: ['{user}', '{role}', '{role.name}'] },
  'role.lost': { label: 'Loses a Role', icon: '🏷️', description: 'When a member loses a role', variables: ['{user}', '{role}', '{role.name}'] },
  'level.up': { label: 'Reaches Level', icon: '⬆️', description: 'When a member levels up', variables: ['{user}', '{oldLevel}', '{newLevel}'] },
  'purchase.completed': { label: 'Purchases Product', icon: '🛒', description: 'When a purchase completes', variables: ['{user}', '{product}', '{amount}'] },
  'subscription.activated': { label: 'Subscription Activated', icon: '🔄', description: 'When a subscription starts', variables: ['{user}', '{plan}'] },
  'subscription.lapsed': { label: 'Subscription Lapsed', icon: '⚠️', description: 'When a subscription lapses', variables: ['{user}', '{plan}'] },
  'subscription.expired': { label: 'Subscription Expired', icon: '⌛', description: 'When a subscription term ends and access is removed', variables: ['{user}', '{plan}'] },
  'ticket.opened': { label: 'Ticket Opened', icon: '🎫', description: 'When a ticket is created', variables: ['{user}', '{ticket}'] },
  'ticket.closed': { label: 'Ticket Closed', icon: '🎫', description: 'When a ticket is closed', variables: ['{ticket}'] },
  'giveaway.ended': { label: 'Giveaway Ended', icon: '🎁', description: 'When a giveaway concludes', variables: ['{giveaway}', '{winners}'] },
  'button.clicked': { label: 'Button Clicked', icon: '🔘', description: 'When a button is clicked', variables: ['{user}', '{buttonId}'] },
  'reaction.added': { label: 'Reaction Added', icon: '😀', description: 'When a reaction is added', variables: ['{user}', '{emoji}', '{channel}'] },
  'voice.joined': { label: 'Voice Joined', icon: '🔊', description: 'When someone joins voice', variables: ['{user}', '{channel}'] },
  'voice.left': { label: 'Voice Left', icon: '🔇', description: 'When someone leaves voice', variables: ['{user}', '{channel}'] },
  'infraction.created': { label: 'Infraction Created', icon: '🔨', description: 'When an infraction is issued', variables: ['{user}', '{type}', '{reason}', '{count}'] },
};

const CONDITION_META: Record<string, { label: string; paramType: string; paramLabel: string }> = {
  'has_role': { label: 'User Has Role', paramType: 'text', paramLabel: 'Role ID' },
  'missing_role': { label: 'User Missing Role', paramType: 'text', paramLabel: 'Role ID' },
  'min_level': { label: 'Minimum Level', paramType: 'number', paramLabel: 'Level' },
  'max_level': { label: 'Maximum Level', paramType: 'number', paramLabel: 'Level' },
  'in_channel': { label: 'In Channel', paramType: 'text', paramLabel: 'Channel ID' },
  'not_in_channel': { label: 'Not In Channel', paramType: 'text', paramLabel: 'Channel ID' },
  'has_entitlement': { label: 'Has Entitlement', paramType: 'text', paramLabel: 'Product ID' },
  'missing_entitlement': { label: 'Missing Entitlement', paramType: 'text', paramLabel: 'Product ID' },
  'message_contains': { label: 'Message Contains', paramType: 'text', paramLabel: 'Text' },
  'message_matches_regex': { label: 'Message Matches Regex', paramType: 'text', paramLabel: 'Pattern' },
  'is_returning_member': { label: 'Is Returning Member', paramType: 'none', paramLabel: '' },
  'is_new_member': { label: 'Is New Member', paramType: 'none', paramLabel: '' },
  'user_is': { label: 'User Is', paramType: 'text', paramLabel: 'User ID' },
};

const ACTION_META: Record<string, { label: string; icon: string; params: { key: string; label: string; type: string; required: boolean; placeholder?: string }[] }> = {
  'send_message': { label: 'Send Message in Channel', icon: '💬', params: [{ key: 'channel_id', label: 'Channel ID', type: 'text', required: true }, { key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: 'Hello {user}!' }] },
  'send_dm': { label: 'Send DM', icon: '📩', params: [{ key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: 'Hey {user.name}!' }] },
  'reply_to_message': { label: 'Reply to Message', icon: '↩️', params: [{ key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: 'Thanks!' }] },
  'give_role': { label: 'Give Role', icon: '🏷️', params: [{ key: 'role_id', label: 'Role ID', type: 'text', required: true }] },
  'remove_role': { label: 'Remove Role', icon: '🏷️', params: [{ key: 'role_id', label: 'Role ID', type: 'text', required: true }] },
  'add_reaction': { label: 'Add Reaction', icon: '😀', params: [{ key: 'emoji', label: 'Emoji', type: 'text', required: true, placeholder: '⭐' }] },
  'delete_message': { label: 'Delete Message', icon: '🗑️', params: [] },
  'create_thread': { label: 'Create Thread', icon: '🧵', params: [{ key: 'name', label: 'Thread Name', type: 'text', required: true }, { key: 'auto_archive_minutes', label: 'Auto-Archive (min)', type: 'number', required: false, placeholder: '1440' }] },
  'wait_delay': { label: 'Wait / Delay', icon: '⏳', params: [{ key: 'seconds', label: 'Seconds', type: 'number', required: true, placeholder: '5' }] },
  'grant_entitlement': { label: 'Grant Entitlement', icon: '🎁', params: [{ key: 'product_id', label: 'Product ID', type: 'text', required: true }] },
  'log_to_channel': { label: 'Log to Channel', icon: '📋', params: [{ key: 'channel_id', label: 'Channel ID', type: 'text', required: true }, { key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: '⚠️ Event: {user}' }] },
  'create_ticket': { label: 'Create Ticket', icon: '🎫', params: [] },
  'ban_member': { label: 'Ban Member', icon: '🔨', params: [{ key: 'reason', label: 'Reason', type: 'text', required: false }] },
  'kick_member': { label: 'Kick Member', icon: '👢', params: [{ key: 'reason', label: 'Reason', type: 'text', required: false }] },
  'mute_member': { label: 'Mute Member', icon: '🔇', params: [{ key: 'duration_minutes', label: 'Duration (min)', type: 'number', required: true, placeholder: '10' }, { key: 'reason', label: 'Reason', type: 'text', required: false }] },
};

// ── Helpers ────────────────────────────────────────────────

function emptyAutomation(): Omit<Automation, 'id' | 'guild_id' | 'execution_count' | 'last_executed_at' | 'created_at'> {
  return {
    name: '',
    description: null,
    trigger_type: 'member.joined',
    trigger_config: {},
    conditions: [],
    actions: [],
    enabled: true,
    target_user_ids: [],
    target_channel_ids: [],
    exclude_user_ids: [],
    exclude_channel_ids: [],
  };
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Main Component ────────────────────────────────────────

export default function AutomationsPage() {
  const { toast } = useToast();

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [holds, setHolds] = useState<MassActionHold[]>([]);
  const [massActionThreshold, setMassActionThreshold] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [activeTab, setActiveTab] = useState<'automations' | 'holds' | 'templates' | 'logs'>('automations');
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: string; name: string } | null>(null);
  const [holdDecision, setHoldDecision] = useState<{ hold: MassActionHold; decision: 'approve' | 'reject' } | null>(null);
  const [draft, setDraft] = useState(emptyAutomation());

  // Selected automation for execution log
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);

  // ── Data fetching ──────────────────────────────────────

  const fetchAutomations = useCallback(async () => {
    const res = await fetch('/api/automations');
    const json = await res.json();
    if (json.success) setAutomations(json.data);
    else setError(json.error);
  }, []);

  const fetchTemplates = useCallback(async () => {
    const res = await fetch('/api/automations/templates');
    const json = await res.json();
    if (json.success) setTemplates(json.data);
  }, []);

  const fetchExecutions = useCallback(async (automationId?: string) => {
    const url = automationId
      ? `/api/automations/executions?automation_id=${automationId}&limit=50`
      : '/api/automations/executions?limit=50';
    const res = await fetch(url);
    const json = await res.json();
    if (json.success) setExecutions(json.data);
  }, []);

  const fetchHolds = useCallback(async () => {
    const res = await fetch('/api/automations/holds');
    const json = await res.json();
    if (json.success) {
      setHolds(json.data);
      setMassActionThreshold(json.threshold);
    } else {
      setError(json.error);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchAutomations(), fetchTemplates(), fetchHolds()])
      .finally(() => setLoading(false));
  }, [fetchAutomations, fetchTemplates, fetchHolds]);

  useAutoRefresh('automations', undefined, fetchAutomations);

  useEffect(() => {
    if (activeTab === 'logs') {
      fetchExecutions(selectedAutomationId ?? undefined);
    }
  }, [activeTab, selectedAutomationId, fetchExecutions]);

  useEffect(() => {
    if (activeTab === 'holds') fetchHolds();
  }, [activeTab, fetchHolds]);

  // ── CRUD ───────────────────────────────────────────────

  const saveAutomation = async () => {
    if (!draft.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);

    try {
      const method = editingId ? 'PUT' : 'POST';
      const body = editingId ? { id: editingId, ...draft } : draft;

      const res = await fetch('/api/automations', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!json.success) {
        setError(json.error);
        return;
      }

      toast({ title: editingId ? 'Automation updated!' : 'Automation created!', variant: 'success' });
      setShowEditor(false);
      setEditingId(null);
      setDraft(emptyAutomation());
      await fetchAutomations();
    } finally {
      setSaving(false);
    }
  };

  const deleteAutomation = async (id: string) => {
    const res = await fetch(`/api/automations?id=${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      toast({ title: 'Automation deleted', variant: 'success' });
      await fetchAutomations();
    } else {
      setError(json.error);
    }
  };

  const toggleEnabled = async (auto: Automation) => {
    const res = await fetch('/api/automations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: auto.id, enabled: !auto.enabled }),
    });
    const json = await res.json();
    if (json.success) {
      await fetchAutomations();
    }
  };

  const decideHold = async (hold: MassActionHold, decision: 'approve' | 'reject') => {
    setSaving(true);
    try {
      const res = await fetch('/api/automations/holds', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hold.id, decision }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error);
        return;
      }
      toast({
        title: decision === 'approve'
          ? 'Held occurrence approved for one-time execution'
          : 'Held occurrence rejected',
        variant: 'success',
      });
      await fetchHolds();
    } finally {
      setSaving(false);
    }
  };

  const saveMassActionThreshold = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/automations/holds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: massActionThreshold }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error);
        return;
      }
      toast({ title: 'Mass-action guardrail updated', variant: 'success' });
    } finally {
      setSaving(false);
    }
  };

  const deployTemplate = async (template: AutomationTemplate) => {
    setSaving(true);
    try {
      const res = await fetch('/api/automations/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: template.id }),
      });
      const json = await res.json();
      if (json.success) {
        toast({ title: `Template "${template.name}" deployed!`, variant: 'success' });
        setActiveTab('automations');
        await fetchAutomations();
      } else {
        setError(json.error);
      }
    } finally {
      setSaving(false);
    }
  };

  const openEditor = (auto?: Automation) => {
    if (auto) {
      setEditingId(auto.id);
      setDraft({
        name: auto.name,
        description: auto.description,
        trigger_type: auto.trigger_type,
        trigger_config: auto.trigger_config,
        conditions: auto.conditions,
        actions: auto.actions,
        enabled: auto.enabled,
        target_user_ids: auto.target_user_ids,
        target_channel_ids: auto.target_channel_ids,
        exclude_user_ids: auto.exclude_user_ids,
        exclude_channel_ids: auto.exclude_channel_ids,
      });
    } else {
      setEditingId(null);
      setDraft(emptyAutomation());
    }
    setShowEditor(true);
  };

  // ── Render ─────────────────────────────────────────────

  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Automations</h1>
          <p className="text-sm text-discord-text-muted">
            Event-driven workflows — triggers → conditions → actions
          </p>
        </div>
        {!showEditor && activeTab === 'automations' && (
          <button
            onClick={() => openEditor()}
            className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-colors"
          >
            + New Automation
          </button>
        )}
      </div>

      {/* Status messages */}
      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-300 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Tabs */}
      {!showEditor && (
        <div className="mb-6 flex gap-1 rounded-lg bg-discord-bg-secondary p-1">
          {(['automations', 'holds', 'templates', 'logs'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-discord-bg-primary text-discord-text-primary'
                  : 'text-discord-text-muted hover:text-discord-text-secondary'
              }`}
            >
              {tab === 'automations'
                ? `Automations (${automations.length})`
                : tab === 'holds'
                  ? `Held (${holds.filter((hold) => hold.status === 'held').length})`
                  : tab === 'templates'
                    ? 'Templates'
                    : 'Execution Log'}
            </button>
          ))}
        </div>
      )}

      {/* Editor */}
      {showEditor && (
        <AutomationEditor
          draft={draft}
          setDraft={setDraft}
          onSave={saveAutomation}
          onCancel={() => { setShowEditor(false); setEditingId(null); setDraft(emptyAutomation()); }}
          saving={saving}
          isEditing={!!editingId}
        />
      )}

      {/* Automations list */}
      {!showEditor && activeTab === 'automations' && (
        <div className="space-y-3">
          {automations.length === 0 ? (
            <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">⚡</div>
              <h3 className="text-lg font-semibold text-discord-text-primary mb-1">No automations yet</h3>
              <p className="text-sm text-discord-text-muted mb-4">Create your first automation or deploy a template.</p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => openEditor()}
                  className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
                >
                  + Create Automation
                </button>
                <button
                  onClick={() => setActiveTab('templates')}
                  className="rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
                >
                  Browse Templates
                </button>
              </div>
            </div>
          ) : (
            automations.map((auto) => {
              const trigger = TRIGGER_META[auto.trigger_type];
              return (
                <div
                  key={auto.id}
                  className={`rounded-lg border bg-discord-bg-secondary p-4 transition-colors ${
                    auto.enabled ? 'border-discord-border-subtle' : 'border-discord-border-subtle/50 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      <span className="text-2xl mt-0.5">{trigger?.icon ?? '⚡'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-discord-text-primary truncate">{auto.name}</h3>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            auto.enabled
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-gray-500/20 text-gray-400'
                          }`}>
                            {auto.enabled ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        {auto.description && (
                          <p className="text-sm text-discord-text-muted mt-0.5">{auto.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-xs text-discord-text-muted">
                          <span>
                            Trigger: <span className="text-discord-text-secondary">{trigger?.label ?? auto.trigger_type}</span>
                          </span>
                          <span>
                            {auto.conditions.length} condition{auto.conditions.length !== 1 ? 's' : ''}
                          </span>
                          <span>
                            {auto.actions.length} action{auto.actions.length !== 1 ? 's' : ''}
                          </span>
                          <span>
                            Fired {auto.execution_count ?? 0}x
                          </span>
                          {auto.last_executed_at && (
                            <span>Last: {timeAgo(auto.last_executed_at)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <button
                        onClick={() => toggleEnabled(auto)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          auto.enabled ? 'bg-green-500' : 'bg-gray-600'
                        }`}
                        title={auto.enabled ? 'Disable' : 'Enable'}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            auto.enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => openEditor(auto)}
                        className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => { setSelectedAutomationId(auto.id); setActiveTab('logs'); }}
                        className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
                      >
                        Logs
                      </button>
                      <button
                        onClick={() => setConfirmAction({ id: auto.id, name: auto.name })}
                        className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-discord-border-subtle"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Mass-action approvals */}
      {!showEditor && activeTab === 'holds' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4">
            <h2 className="font-semibold text-discord-text-primary">Mass-action guardrail</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Hold any single automation occurrence that would affect more than this many members.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <input
                aria-label="Mass-action member threshold"
                type="number"
                min={1}
                max={500}
                value={massActionThreshold}
                onChange={(event) => setMassActionThreshold(Number(event.target.value))}
                className="w-28 rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary"
              />
              <button
                onClick={saveMassActionThreshold}
                disabled={saving || !Number.isInteger(massActionThreshold) || massActionThreshold < 1 || massActionThreshold > 500}
                className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Save guardrail
              </button>
            </div>
          </div>

          {holds.length === 0 ? (
            <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center">
              <p className="text-sm text-discord-text-muted">No held mass-action occurrences.</p>
            </div>
          ) : holds.map((hold) => {
            const automation = automations.find((item) => item.id === hold.automation_id);
            return (
              <div key={hold.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-discord-text-primary">
                        {automation?.name ?? hold.automation_id.slice(0, 8)}
                      </h3>
                      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
                        {hold.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-discord-text-secondary">
                      {hold.member_count} members from {hold.trigger_event}; guardrail was {hold.threshold}.
                    </p>
                    <p className="mt-1 text-xs text-discord-text-muted">
                      Held {timeAgo(hold.created_at)}.{' '}
                      {hold.status === 'held' || hold.status === 'approved'
                        ? 'No member-targeted action ran before approval.'
                        : hold.status === 'executing'
                          ? 'Execution is in progress.'
                          : 'Execution did not finish cleanly; inspect the audit log before applying corrective actions manually.'}
                    </p>
                    {hold.last_error && (
                      <p className="mt-2 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
                        {hold.last_error}
                      </p>
                    )}
                  </div>
                  {hold.status === 'held' && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setHoldDecision({ hold, decision: 'reject' })}
                        disabled={saving}
                        className="rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-red-400 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => setHoldDecision({ hold, decision: 'approve' })}
                        disabled={saving}
                        className="rounded-md bg-amber-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
                      >
                        Approve once
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Templates */}
      {!showEditor && activeTab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((template) => {
            const trigger = TRIGGER_META[template.trigger_type];
            return (
              <div
                key={template.id}
                className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="text-3xl">{template.icon}</span>
                  <div className="flex-1">
                    <h3 className="font-semibold text-discord-text-primary">{template.name}</h3>
                    <p className="text-sm text-discord-text-muted mt-1">{template.description}</p>
                    <div className="flex items-center gap-3 mt-3 text-xs text-discord-text-muted">
                      <span className="inline-flex items-center gap-1 rounded-full bg-discord-bg-primary px-2 py-0.5">
                        {trigger?.icon} {trigger?.label}
                      </span>
                      <span>{template.actions.length} action{template.actions.length !== 1 ? 's' : ''}</span>
                      <span className="capitalize">{template.category}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => deployTemplate(template)}
                    disabled={saving}
                    className="flex-1 rounded-md bg-discord-accent px-3 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50 transition-colors"
                  >
                    Deploy Template
                  </button>
                  <button
                    onClick={() => {
                      setDraft({
                        name: template.name,
                        description: template.description,
                        trigger_type: template.trigger_type,
                        trigger_config: template.trigger_config,
                        conditions: template.conditions,
                        actions: template.actions,
                        enabled: true,
                        target_user_ids: [],
                        target_channel_ids: [],
                        exclude_user_ids: [],
                        exclude_channel_ids: [],
                      });
                      setEditingId(null);
                      setShowEditor(true);
                    }}
                    className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
                  >
                    Customize
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Execution Logs */}
      {!showEditor && activeTab === 'logs' && (
        <div>
          <div className="mb-4 flex items-center gap-3">
            <select
              value={selectedAutomationId ?? ''}
              onChange={(e) => setSelectedAutomationId(e.target.value || null)}
              className="rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary"
            >
              <option value="">All Automations</option>
              {automations.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <button
              onClick={() => fetchExecutions(selectedAutomationId ?? undefined)}
              className="rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
            >
              Refresh
            </button>
          </div>
          {executions.length === 0 ? (
            <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center">
              <p className="text-sm text-discord-text-muted">No executions recorded yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => {
                const auto = automations.find((a) => a.id === exec.automation_id);
                const hasErrors = exec.actions_failed > 0;
                return (
                  <div
                    key={exec.id}
                    className={`rounded-lg border bg-discord-bg-secondary p-3 text-sm ${
                      hasErrors ? 'border-red-500/30' : exec.conditions_passed ? 'border-discord-border-subtle' : 'border-yellow-500/20'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`inline-flex h-2 w-2 rounded-full ${
                          hasErrors ? 'bg-red-400' : exec.conditions_passed ? 'bg-green-400' : 'bg-yellow-400'
                        }`} />
                        <span className="font-medium text-discord-text-primary">
                          {auto?.name ?? exec.automation_id.slice(0, 8)}
                        </span>
                        <span className="text-discord-text-muted">
                          {exec.trigger_event}
                        </span>
                        <span className="text-discord-text-muted">
                          by {exec.triggered_by === 'system' ? 'system' : exec.triggered_by.slice(0, 8)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-discord-text-muted">
                        {exec.conditions_passed ? (
                          <span className="text-green-400">
                            {exec.actions_executed} action{exec.actions_executed !== 1 ? 's' : ''} OK
                            {exec.actions_failed > 0 && <span className="text-red-400 ml-1">/ {exec.actions_failed} failed</span>}
                          </span>
                        ) : (
                          <span className="text-yellow-400">Conditions not met</span>
                        )}
                        <span>{exec.duration_ms}ms</span>
                        <span>{timeAgo(exec.created_at)}</span>
                      </div>
                    </div>
                    {exec.errors && exec.errors.length > 0 && (
                      <div className="mt-2 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
                        {exec.errors.map((e, i) => <div key={i}>{e}</div>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmAction}
        title="Delete Automation"
        description={`Are you sure you want to delete "${confirmAction?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmAction) {
            await deleteAutomation(confirmAction.id);
            setConfirmAction(null);
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={!!holdDecision}
        title={holdDecision?.decision === 'approve' ? 'Approve mass action' : 'Reject mass action'}
        description={holdDecision?.decision === 'approve'
          ? `Execute this occurrence once across ${holdDecision.hold.member_count} members? The guardrail stopped every member-targeted action so far.`
          : 'Reject this held occurrence permanently? It will not execute.'}
        confirmLabel={holdDecision?.decision === 'approve' ? 'Approve once' : 'Reject'}
        variant={holdDecision?.decision === 'approve' ? 'warning' : 'danger'}
        onConfirm={async () => {
          if (holdDecision) {
            await decideHold(holdDecision.hold, holdDecision.decision);
            setHoldDecision(null);
          }
        }}
        onCancel={() => setHoldDecision(null)}
      />
    </div>
  );
}

// ── Editor Component ──────────────────────────────────────

function AutomationEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  isEditing,
}: {
  draft: ReturnType<typeof emptyAutomation>;
  setDraft: (d: ReturnType<typeof emptyAutomation>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isEditing: boolean;
}) {
  const trigger = TRIGGER_META[draft.trigger_type];
  const [showScope, setShowScope] = useState(false);

  const addCondition = () => {
    setDraft({
      ...draft,
      conditions: [...draft.conditions, { type: 'has_role', config: { value: '' } }],
    });
  };

  const removeCondition = (index: number) => {
    setDraft({
      ...draft,
      conditions: draft.conditions.filter((_, i) => i !== index),
    });
  };

  const updateCondition = (index: number, updates: Partial<AutomationCondition>) => {
    const newConditions = [...draft.conditions];
    newConditions[index] = { ...newConditions[index], ...updates };
    setDraft({ ...draft, conditions: newConditions });
  };

  const addAction = () => {
    setDraft({
      ...draft,
      actions: [...draft.actions, { type: 'send_message', config: { channel_id: '', message: '' } }],
    });
  };

  const removeAction = (index: number) => {
    setDraft({
      ...draft,
      actions: draft.actions.filter((_, i) => i !== index),
    });
  };

  const updateAction = (index: number, updates: Partial<AutomationAction>) => {
    const newActions = [...draft.actions];
    newActions[index] = { ...newActions[index], ...updates };
    setDraft({ ...draft, actions: newActions });
  };

  const moveAction = (index: number, direction: 'up' | 'down') => {
    const newActions = [...draft.actions];
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= newActions.length) return;
    [newActions[index], newActions[target]] = [newActions[target], newActions[index]];
    setDraft({ ...draft, actions: newActions });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          {isEditing ? 'Edit Automation' : 'New Automation'}
        </h2>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Automation'}
          </button>
        </div>
      </div>

      {/* Name + Description */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-discord-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Welcome DM"
            className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-discord-text-secondary mb-1">Description (optional)</label>
          <input
            type="text"
            value={draft.description ?? ''}
            onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
            placeholder="What does this automation do?"
            className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
          />
        </div>
      </div>

      {/* Trigger */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-3 flex items-center gap-2">
          <span className="text-lg">⚡</span> Trigger
        </h3>
        <select
          value={draft.trigger_type}
          onChange={(e) => setDraft({ ...draft, trigger_type: e.target.value, trigger_config: {} })}
          className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary focus:outline-none focus:ring-2 focus:ring-discord-accent"
        >
          {Object.entries(TRIGGER_META).map(([key, meta]) => (
            <option key={key} value={key}>{meta.icon} {meta.label}</option>
          ))}
        </select>
        {trigger && (
          <div className="mt-2 text-xs text-discord-text-muted">
            {trigger.description}
            {trigger.variables.length > 0 && (
              <VariableChips
                variables={trigger.variables.map((v) => ({ key: v, desc: 'Trigger variable' }))}
              />
            )}
          </div>
        )}

        {/* Scope */}
        <div className="mt-4">
          <button
            onClick={() => setShowScope(!showScope)}
            className="text-xs text-discord-text-muted hover:text-discord-text-secondary flex items-center gap-1"
          >
            <span>{showScope ? '▾' : '▸'}</span>
            Scope (optional)
          </button>
          {showScope && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-discord-text-muted mb-1">Target User IDs</label>
                <input
                  type="text"
                  value={draft.target_user_ids.join(', ')}
                  onChange={(e) => setDraft({ ...draft, target_user_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="Leave empty for all users"
                  className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-discord-text-muted mb-1">Exclude User IDs</label>
                <input
                  type="text"
                  value={draft.exclude_user_ids.join(', ')}
                  onChange={(e) => setDraft({ ...draft, exclude_user_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="None"
                  className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-discord-text-muted mb-1">Target Channel IDs</label>
                <input
                  type="text"
                  value={draft.target_channel_ids.join(', ')}
                  onChange={(e) => setDraft({ ...draft, target_channel_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="Leave empty for all channels"
                  className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-discord-text-muted mb-1">Exclude Channel IDs</label>
                <input
                  type="text"
                  value={draft.exclude_channel_ids.join(', ')}
                  onChange={(e) => setDraft({ ...draft, exclude_channel_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  placeholder="None"
                  className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:outline-none focus:ring-2 focus:ring-discord-accent"
                />
              </div>
              <p className="col-span-2 text-xs text-discord-text-muted">ℹ️ Leave empty for full server scope.</p>
            </div>
          )}
        </div>
      </div>

      {/* Conditions */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-discord-text-primary flex items-center gap-2">
            <span className="text-lg">🔍</span> Conditions
            <span className="text-xs font-normal text-discord-text-muted">(all must pass)</span>
          </h3>
          <button
            onClick={addCondition}
            disabled={draft.conditions.length >= 5}
            className="rounded-md bg-discord-bg-tertiary px-3 py-1 text-xs font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle disabled:opacity-50"
          >
            + Add Condition
          </button>
        </div>

        {draft.conditions.length === 0 ? (
          <p className="text-xs text-discord-text-muted">No conditions — automation fires on every trigger match.</p>
        ) : (
          <div className="space-y-3">
            {draft.conditions.map((cond, idx) => {
              const meta = CONDITION_META[cond.type];
              return (
                <div key={idx} className="flex items-center gap-3 rounded-md bg-discord-bg-primary p-3">
                  <select
                    value={cond.type}
                    onChange={(e) => updateCondition(idx, { type: e.target.value, config: { value: '' } })}
                    className="rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-2 py-1.5 text-xs text-discord-text-primary"
                  >
                    {Object.entries(CONDITION_META).map(([key, m]) => (
                      <option key={key} value={key}>{m.label}</option>
                    ))}
                  </select>
                  {meta && meta.paramType !== 'none' && (
                    <input
                      type={meta.paramType === 'number' ? 'number' : 'text'}
                      value={(cond.config.value as string) ?? ''}
                      onChange={(e) => updateCondition(idx, { config: { value: meta.paramType === 'number' ? parseInt(e.target.value) || 0 : e.target.value } })}
                      placeholder={meta.paramLabel}
                      className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-2 py-1.5 text-xs text-discord-text-primary placeholder:text-discord-text-muted"
                    />
                  )}
                  <button
                    onClick={() => removeCondition(idx)}
                    className="text-red-400 hover:text-red-300 text-xs"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-discord-text-primary flex items-center gap-2">
            <span className="text-lg">🎬</span> Actions
            <span className="text-xs font-normal text-discord-text-muted">(execute in order)</span>
          </h3>
          <button
            onClick={addAction}
            disabled={draft.actions.length >= 10}
            className="rounded-md bg-discord-bg-tertiary px-3 py-1 text-xs font-medium text-discord-text-secondary hover:text-discord-text-primary border border-discord-border-subtle disabled:opacity-50"
          >
            + Add Action
          </button>
        </div>

        {draft.actions.length === 0 ? (
          <p className="text-xs text-discord-text-muted">Add at least one action.</p>
        ) : (
          <div className="space-y-3">
            {draft.actions.map((action, idx) => {
              const meta = ACTION_META[action.type];
              return (
                <div key={idx} className="rounded-md bg-discord-bg-primary p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-sm font-medium text-discord-text-muted w-5 text-center">{idx + 1}</span>
                    <select
                      value={action.type}
                      onChange={(e) => {
                        const newMeta = ACTION_META[e.target.value];
                        const newConfig: Record<string, unknown> = {};
                        if (newMeta) {
                          for (const p of newMeta.params) {
                            newConfig[p.key] = '';
                          }
                        }
                        updateAction(idx, { type: e.target.value, config: newConfig });
                      }}
                      className="rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-2 py-1.5 text-xs text-discord-text-primary"
                    >
                      {Object.entries(ACTION_META).map(([key, m]) => (
                        <option key={key} value={key}>{m.icon} {m.label}</option>
                      ))}
                    </select>
                    <div className="flex-1" />
                    <button
                      onClick={() => moveAction(idx, 'up')}
                      disabled={idx === 0}
                      className="text-discord-text-muted hover:text-discord-text-primary text-xs disabled:opacity-30"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveAction(idx, 'down')}
                      disabled={idx === draft.actions.length - 1}
                      className="text-discord-text-muted hover:text-discord-text-primary text-xs disabled:opacity-30"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeAction(idx)}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                  {meta && meta.params.length > 0 && (
                    <div className="ml-8 space-y-2">
                      {meta.params.map((param) => (
                        <div key={param.key} className="flex items-center gap-2">
                          <label className="text-xs text-discord-text-muted w-28 shrink-0">{param.label}</label>
                          {param.type === 'textarea' ? (
                            <textarea
                              value={(action.config[param.key] as string) ?? ''}
                              onChange={(e) => updateAction(idx, { config: { ...action.config, [param.key]: e.target.value } })}
                              placeholder={param.placeholder}
                              rows={2}
                              className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-2 py-1.5 text-xs text-discord-text-primary placeholder:text-discord-text-muted resize-none"
                            />
                          ) : (
                            <input
                              type={param.type === 'number' ? 'number' : 'text'}
                              value={(action.config[param.key] as string) ?? ''}
                              onChange={(e) => updateAction(idx, { config: { ...action.config, [param.key]: param.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value } })}
                              placeholder={param.placeholder}
                              className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-2 py-1.5 text-xs text-discord-text-primary placeholder:text-discord-text-muted"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
