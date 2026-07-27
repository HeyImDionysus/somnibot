/**
 * Tutorial Configuration — Manage server tutorial steps.
 *
 * V53 Phase 3 (Finding 3.2 — M-8)
 */
'use client';

import { DashboardSkeleton } from '@/components/shared/loading-skeleton';
import { useEffect, useState, useCallback } from 'react';

interface TutorialConfig {
  enabled: boolean;
  auto_trigger: boolean;
  trigger_mode: string;
}

interface TutorialStep {
  id: string;
  step_order: number;
  title: string;
  description: string;
  image_url: string | null;
  built_in_key: string | null;
  enabled: boolean;
}

const BUILT_IN_STEPS = [
  { key: 'welcome', title: '👋 Welcome', description: 'Introduction to the server' },
  { key: 'economy', title: '💰 Economy', description: 'Economy commands overview' },
  { key: 'leveling', title: '📈 Leveling', description: 'XP and leveling system' },
  { key: 'music', title: '🎵 Music', description: 'Music playback commands' },
  { key: 'tickets', title: '🎫 Tickets', description: 'Support ticket system' },
  { key: 'fun', title: '🎮 Fun & Games', description: 'Games and activities' },
];

export default function TutorialPage() {
  const [config, setConfig] = useState<TutorialConfig>({
    enabled: false,
    auto_trigger: false,
    trigger_mode: 'first_command',
  });
  const [steps, setSteps] = useState<TutorialStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/tutorial');
      const json = await res.json();
      if (json.success) {
        if (json.config) setConfig(json.config);
        if (json.steps) setSteps(json.steps);
      }
    } catch {
      setError('Failed to load tutorial config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/tutorial', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, steps }),
      });
      const json = await res.json();
      if (json.success) {
        setSuccess('Tutorial config saved!');
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError(json.error || 'Failed to save');
      }
    } catch {
      setError('Failed to save tutorial config');
    } finally {
      setSaving(false);
    }
  };

  const addStep = () => {
    setSteps((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        step_order: prev.length,
        title: '',
        description: '',
        image_url: null,
        built_in_key: null,
        enabled: true,
      },
    ]);
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_order: i })));
  };

  const updateStep = (idx: number, field: string, value: string | boolean) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)),
    );
  };

  const moveStep = (idx: number, direction: -1 | 1) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= steps.length) return;
    setSteps((prev) => {
      const arr = [...prev];
      const tmp = arr[idx];
      arr[idx] = arr[newIdx]!;
      arr[newIdx] = tmp!;
      return arr.map((s, i) => ({ ...s, step_order: i }));
    });
  };

  const initBuiltIn = () => {
    setSteps(
      BUILT_IN_STEPS.map((s, i) => ({
        id: `builtin-${s.key}`,
        step_order: i,
        title: s.title,
        description: s.description,
        image_url: null,
        built_in_key: s.key,
        enabled: true,
      })),
    );
  };

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Tutorial System</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Configure the interactive server tutorial that members see when they run /tutorial.
          </p>
        </div>
        <button
          onClick={saveConfig}
          disabled={saving}
          className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
          {success}
        </div>
      )}

      {/* Config toggles */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-4">
        <h2 className="text-lg font-medium text-discord-text-primary">Settings</h2>

        <label className="flex items-center justify-between">
          <span className="text-sm text-discord-text-secondary">Enable tutorial system</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
            className="h-5 w-5 rounded border-discord-border-subtle"
          />
        </label>

        <label className="flex items-center justify-between">
          <div>
            <span className="text-sm text-discord-text-secondary">Auto-trigger for new users</span>
            <p className="text-xs text-discord-text-muted">
              Prompt new users with the tutorial on their first command
            </p>
          </div>
          <input
            type="checkbox"
            checked={config.auto_trigger}
            onChange={(e) => setConfig({ ...config, auto_trigger: e.target.checked })}
            className="h-5 w-5 rounded border-discord-border-subtle"
          />
        </label>

        <label className="flex items-center justify-between">
          <span className="text-sm text-discord-text-secondary">Trigger mode</span>
          <select
            value={config.trigger_mode}
            onChange={(e) => setConfig({ ...config, trigger_mode: e.target.value })}
            className="rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-primary"
          >
            <option value="first_command">First command</option>
            <option value="join">On join</option>
            <option value="disabled">Manual only (/tutorial)</option>
          </select>
        </label>
      </div>

      {/* Tutorial Steps */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-discord-text-primary">
            Steps ({steps.length})
          </h2>
          <div className="flex gap-2">
            {steps.length === 0 && (
              <button
                onClick={initBuiltIn}
                className="rounded-md border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary"
              >
                Load Default Steps
              </button>
            )}
            <button
              onClick={addStep}
              className="rounded-md bg-discord-blurple px-3 py-1.5 text-xs text-white hover:bg-discord-blurple/80"
            >
              + Add Step
            </button>
          </div>
        </div>

        {steps.length === 0 ? (
          <p className="text-sm text-discord-text-muted text-center py-6">
            No steps yet. Add custom steps or load the defaults.
          </p>
        ) : (
          <div className="space-y-3">
            {steps.map((step, idx) => (
              <div
                key={step.id}
                className="rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-discord-text-muted font-mono">
                    Step {idx + 1}
                    {step.built_in_key && (
                      <span className="ml-2 rounded bg-discord-blurple/20 px-1.5 py-0.5 text-discord-blurple">
                        built-in: {step.built_in_key}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => moveStep(idx, -1)}
                      disabled={idx === 0}
                      className="rounded px-2 py-1 text-xs text-discord-text-muted hover:text-discord-text-primary disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveStep(idx, 1)}
                      disabled={idx === steps.length - 1}
                      className="rounded px-2 py-1 text-xs text-discord-text-muted hover:text-discord-text-primary disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeStep(idx)}
                      className="rounded px-2 py-1 text-xs text-red-400 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={step.title}
                  onChange={(e) => updateStep(idx, 'title', e.target.value)}
                  placeholder="Step title..."
                  className="w-full rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent/50 focus:outline-none"
                />
                <textarea
                  value={step.description}
                  onChange={(e) => updateStep(idx, 'description', e.target.value)}
                  placeholder="Step description (supports markdown)..."
                  rows={3}
                  className="w-full rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent/50 focus:outline-none resize-y"
                />
                <input
                  type="text"
                  value={step.image_url ?? ''}
                  onChange={(e) => updateStep(idx, 'image_url', e.target.value)}
                  placeholder="Image URL (optional)..."
                  className="w-full rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent/50 focus:outline-none"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
