/**
 * Economy Trivia Management — custom question packs, difficulty rewards, categories.
 *
 * Admins manage custom trivia questions (CSV import/export),
 * configure difficulty multipliers, streak bonuses, and cooldowns.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Brain, Plus, Pencil, Trash2, Upload, Download } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface TriviaQuestion {
  id: string;
  category: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  wrong_answers: string[];
}

interface TriviaConfig {
  economy_trivia_enabled: boolean;
  economy_trivia_cooldown_seconds: number;
  economy_trivia_base_payout: number;
  economy_trivia_streak_multiplier_pct: number;
  economy_trivia_hard_multiplier: number;
}

const DEFAULT_CONFIG: TriviaConfig = {
  economy_trivia_enabled: false,
  economy_trivia_cooldown_seconds: 30,
  economy_trivia_base_payout: 50,
  economy_trivia_streak_multiplier_pct: 10,
  economy_trivia_hard_multiplier: 2,
};

const CATEGORIES = ['general', 'science', 'history', 'geography', 'art', 'math', 'technology', 'literature'] as const;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

const BLANK_QUESTION: Omit<TriviaQuestion, 'id'> & { id?: string } = {
  category: 'general',
  difficulty: 'medium',
  question: '',
  correct_answer: '',
  wrong_answers: ['', '', ''],
};

// ── Helpers ───────────────────────────────────────────────

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        className={`relative w-11 h-6 rounded-full transition-colors ${
          checked ? 'bg-brand-primary' : 'bg-discord-bg-tertiary'
        }`}
        onClick={() => onChange(!checked)}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </div>
      <span className="text-sm text-discord-text-primary">{label}</span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <span className="block text-sm text-discord-text-secondary mb-1">{label}</span>
      <input
        type="number"
        className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────

export default function TriviaPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<TriviaConfig>(DEFAULT_CONFIG);
  const [questions, setQuestions] = useState<TriviaQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<TriviaQuestion, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Fetch ─────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, questionsRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/trivia'),
      ]);
      if (cfgRes.ok) {
        const cfgJson = await cfgRes.json();
        const gc = cfgJson.guild_config ?? cfgJson;
        setConfig({
          economy_trivia_enabled: gc.economy_trivia_enabled ?? false,
          economy_trivia_cooldown_seconds: gc.economy_trivia_cooldown_seconds ?? 30,
          economy_trivia_base_payout: gc.economy_trivia_base_payout ?? 50,
          economy_trivia_streak_multiplier_pct: gc.economy_trivia_streak_multiplier_pct ?? 10,
          economy_trivia_hard_multiplier: gc.economy_trivia_hard_multiplier ?? 2,
        });
      }
      if (questionsRes.ok) {
        const qJson = await questionsRes.json();
        setQuestions(qJson.questions ?? []);
      }
    } catch {
      toast({ title: 'Failed to load trivia data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Save config ───────────────────────────────────────

  const saveConfig = async (patch: Partial<TriviaConfig>) => {
    const updated = { ...config, ...patch };
    setConfig(updated);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Settings saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save', variant: 'error' });
    }
  };

  // ── CRUD questions ────────────────────────────────────

  const saveQuestion = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/trivia', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error();
      toast({ title: editing.id ? 'Question updated' : 'Question created', variant: 'success' });
      setEditing(null);
      await loadData();
    } catch {
      toast({ title: 'Failed to save question', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteQuestion = async () => {
    if (!deleteId) return;
    try {
      await fetch(`/api/economy/trivia?id=${deleteId}`, { method: 'DELETE' });
      toast({ title: 'Question deleted', variant: 'success' });
      setDeleteId(null);
      await loadData();
    } catch {
      toast({ title: 'Failed to delete', variant: 'error' });
    }
  };

  // ── CSV Export ────────────────────────────────────────

  const exportCsv = () => {
    const rows = [['category', 'difficulty', 'question', 'correct_answer', 'wrong1', 'wrong2', 'wrong3']];
    for (const q of questions) {
      rows.push([q.category, q.difficulty, q.question, q.correct_answer, ...(q.wrong_answers ?? [])]);
    }
    const csv = rows.map((r) => r.map((c) => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trivia_questions.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── CSV Import ────────────────────────────────────────

  const importCsv = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split('\n').slice(1).filter(Boolean);
      let imported = 0;
      for (const line of lines) {
        const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
        if (cols.length >= 5) {
          const q = {
            category: cols[0] || 'general',
            difficulty: cols[1] || 'medium',
            question: cols[2],
            correct_answer: cols[3],
            wrong_answers: cols.slice(4).filter(Boolean),
          };
          await fetch('/api/economy/trivia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(q),
          });
          imported++;
        }
      }
      toast({ title: `Imported ${imported} questions`, variant: 'success' });
      await loadData();
    };
    input.click();
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-discord-text-primary flex items-center gap-2">
          <Brain className="w-6 h-6" /> Trivia Settings
        </h1>
      </div>

      {/* Config */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 space-y-4">
        <Toggle
          label="Enable Trivia"
          checked={config.economy_trivia_enabled}
          onChange={(v) => saveConfig({ economy_trivia_enabled: v })}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <NumberField
            label="Cooldown (seconds)"
            value={config.economy_trivia_cooldown_seconds}
            onChange={(v) => saveConfig({ economy_trivia_cooldown_seconds: v })}
            min={5}
            max={3600}
          />
          <NumberField
            label="Base Payout"
            value={config.economy_trivia_base_payout}
            onChange={(v) => saveConfig({ economy_trivia_base_payout: v })}
            min={0}
            max={1000000}
          />
          <NumberField
            label="Streak Multiplier (%)"
            value={config.economy_trivia_streak_multiplier_pct}
            onChange={(v) => saveConfig({ economy_trivia_streak_multiplier_pct: v })}
            min={0}
            max={100}
          />
          <NumberField
            label="Hard Difficulty Multiplier"
            value={config.economy_trivia_hard_multiplier}
            onChange={(v) => saveConfig({ economy_trivia_hard_multiplier: v })}
            min={1}
            max={10}
            step={0.1}
          />
        </div>
      </div>

      {/* Custom Questions */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-discord-text-primary">Custom Questions ({questions.length})</h2>
          <div className="flex gap-2">
            <button onClick={importCsv} className="flex items-center gap-1 rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs text-discord-text-primary hover:bg-discord-bg-hover">
              <Upload className="w-3 h-3" /> Import CSV
            </button>
            <button onClick={exportCsv} className="flex items-center gap-1 rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs text-discord-text-primary hover:bg-discord-bg-hover">
              <Download className="w-3 h-3" /> Export CSV
            </button>
            <button
              onClick={() => setEditing({ ...BLANK_QUESTION })}
              className="flex items-center gap-1 rounded-md bg-brand-primary px-3 py-1.5 text-xs text-white hover:bg-brand-primary-hover"
            >
              <Plus className="w-3 h-3" /> Add Question
            </button>
          </div>
        </div>

        {questions.length === 0 ? (
          <EmptyState icon={Brain} title="No custom questions" description="Add questions or import a CSV pack." />
        ) : (
          <div className="space-y-2">
            {questions.map((q) => (
              <div
                key={q.id}
                className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-discord-text-primary truncate">{q.question}</p>
                  <p className="text-xs text-discord-text-secondary">
                    {q.category} • {q.difficulty} • Answer: {q.correct_answer}
                  </p>
                </div>
                <div className="flex gap-1 ml-2">
                  <button onClick={() => setEditing({ ...q })} className="p-1.5 rounded hover:bg-discord-bg-hover">
                    <Pencil className="w-3.5 h-3.5 text-discord-text-secondary" />
                  </button>
                  <button onClick={() => setDeleteId(q.id)} className="p-1.5 rounded hover:bg-discord-bg-hover">
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-lg bg-discord-bg-secondary p-6 space-y-4">
            <h3 className="text-lg font-bold text-discord-text-primary">
              {editing.id ? 'Edit Question' : 'New Question'}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="block text-xs text-discord-text-secondary mb-1">Category</span>
                <select
                  className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
                  value={editing.category}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, category: e.target.value })}
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <span className="block text-xs text-discord-text-secondary mb-1">Difficulty</span>
                <select
                  className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
                  value={editing.difficulty}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, difficulty: e.target.value })}
                >
                  {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div>
              <span className="block text-xs text-discord-text-secondary mb-1">Question</span>
              <textarea
                className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
                rows={2}
                value={editing.question}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, question: e.target.value })}
              />
            </div>
            <div>
              <span className="block text-xs text-discord-text-secondary mb-1">Correct Answer</span>
              <input
                className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
                value={editing.correct_answer}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, correct_answer: e.target.value })}
              />
            </div>
            <div>
              <span className="block text-xs text-discord-text-secondary mb-1">Wrong Answers</span>
              {(editing.wrong_answers ?? []).map((wa, i) => (
                <input
                  key={i}
                  className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary mb-1"
                  placeholder={`Wrong answer ${i + 1}`}
                  value={wa}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const arr = [...(editing.wrong_answers ?? [])];
                    arr[i] = e.target.value;
                    setEditing({ ...editing, wrong_answers: arr });
                  }}
                />
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-primary">
                Cancel
              </button>
              <button onClick={saveQuestion} disabled={saving} className="rounded-md bg-brand-primary px-4 py-2 text-sm text-white">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="Delete Question"
        description="Are you sure? This cannot be undone."
        variant="danger"
        onConfirm={deleteQuestion}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
