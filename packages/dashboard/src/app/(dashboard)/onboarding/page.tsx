/**
 * Onboarding Configuration Page
 *
 * Controls @everyone permissions (locked to zero), Discord native onboarding
 * integration, Member role assignment, interest role mapping, and returning
 * member behavior.
 *
 * Architecture doc §16.4
 */
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';

interface OnboardingPromptOption {
  title: string;
  description?: string;
  emoji?: string;
  role_ids?: string[];
  channel_ids?: string[];
}

interface OnboardingPrompt {
  title: string;
  type: 'multiple_choice' | 'dropdown';
  required: boolean;
  single_select: boolean;
  options: OnboardingPromptOption[];
}

interface NativeOnboardingConfig {
  enabled: boolean;
  prompts: OnboardingPrompt[];
  default_channel_ids: string[];
}

interface OnboardingConfig {
  member_role_id: string | null;
  onboarding_enabled: boolean;
  interest_role_mapping: Record<string, string>;
  returning_member_skip_welcome_dm: boolean;
  returning_member_restore_entitlements: boolean;
  returning_member_restore_levels: boolean;
  onboarding_config: NativeOnboardingConfig | null;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

const DEFAULT_CONFIG: OnboardingConfig = {
  member_role_id: null,
  onboarding_enabled: true,
  interest_role_mapping: {},
  returning_member_skip_welcome_dm: true,
  returning_member_restore_entitlements: true,
  returning_member_restore_levels: true,
  onboarding_config: null,
};

export default function OnboardingPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<OnboardingConfig>(DEFAULT_CONFIG);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty);
  const [error, setError] = useState<string | null>(null);

  // New interest mapping inputs
  const [newInterestName, setNewInterestName] = useState('');
  const [newInterestRole, setNewInterestRole] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [configRes, rolesRes] = await Promise.all([
          fetch('/api/onboarding'),
          fetch('/api/roles'),
        ]);
        const configJson = await configRes.json();
        const rolesJson = await rolesRes.json();

        if (configJson.success && configJson.data) {
          setConfig({ ...DEFAULT_CONFIG, ...configJson.data });
        }
        if (rolesJson.success && rolesJson.data) {
          setRoles(rolesJson.data);
        }
      } catch (err) {
        setError('Failed to load configuration');
        toast({ title: 'Failed to load configuration', variant: 'error' });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [toast]);

  // Track unsaved changes
  const configLoaded = useRef(false);
  useEffect(() => {
    if (!loading && configLoaded.current) setDirty(true);
    if (!loading) configLoaded.current = true;
  }, [config, loading]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: 'Settings saved', variant: 'success' });
      setDirty(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [config, toast]);

  const addInterestMapping = () => {
    if (!newInterestName.trim() || !newInterestRole) return;
    setConfig((prev) => ({
      ...prev,
      interest_role_mapping: {
        ...prev.interest_role_mapping,
        [newInterestName.trim()]: newInterestRole,
      },
    }));
    setNewInterestName('');
    setNewInterestRole('');
  };

  const removeInterestMapping = (key: string) => {
    setConfig((prev) => {
      const mapping = { ...prev.interest_role_mapping };
      delete mapping[key];
      return { ...prev, interest_role_mapping: mapping };
    });
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">
          Onboarding
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure how new members are verified and granted access.
        </p>
      </div>

      {/* @everyone Lockdown */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
            🔒
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-discord-text-primary">
              @everyone Permissions
            </h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              @everyone is set to <strong className="text-red-400">zero permissions</strong>. This is by design
              and cannot be changed. New members see only the Discord onboarding screen until they
              complete it and receive the Member role.
            </p>
            <div className="mt-3 rounded border border-discord-border bg-discord-bg-tertiary px-4 py-2 text-xs text-discord-text-muted">
              All permissions come from the Member role and above. @everyone = 0 ensures
              unverified members cannot access any channels.
            </div>
          </div>
        </div>
      </section>

      {/* Discord Onboarding Toggle */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary">
              Discord Onboarding
            </h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Uses Discord&apos;s native onboarding (rules acceptance, customization questions).
              When a member completes it, the bot detects the completion flag and grants the Member role.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={config.onboarding_enabled}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, onboarding_enabled: e.target.checked }))
              }
            />
            <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
          </label>
        </div>
      </section>

      {/* Member Role Selection */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          Member Role
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          The role granted when a member completes onboarding. This unlocks channel access.
        </p>
        <select
          className="mt-3 w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-somni-pink focus:outline-none"
          value={config.member_role_id ?? ''}
          onChange={(e) =>
            setConfig((prev) => ({
              ...prev,
              member_role_id: e.target.value || null,
            }))
          }
        >
          <option value="">Select a role...</option>
          {roles
            .filter((r) => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
        </select>
      </section>

      {/* Interest Role Mapping */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          Interest Roles
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Map Discord onboarding customization options to roles. When a member selects
          an interest during onboarding, they receive the mapped role.
        </p>

        {Object.entries(config.interest_role_mapping).length > 0 && (
          <div className="mt-4 space-y-2">
            {Object.entries(config.interest_role_mapping).map(([name, roleId]) => {
              const role = roles.find((r) => r.id === roleId);
              return (
                <div
                  key={name}
                  className="flex items-center justify-between rounded border border-discord-border bg-discord-bg-tertiary px-3 py-2"
                >
                  <span className="text-sm text-discord-text-primary">
                    &quot;{name}&quot; → <span className="text-somni-cyan">{role?.name ?? roleId}</span>
                  </span>
                  <button
                    onClick={() => removeInterestMapping(name)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            placeholder="Interest name..."
            value={newInterestName}
            onChange={(e) => setNewInterestName(e.target.value)}
            className="flex-1 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
          />
          <select
            value={newInterestRole}
            onChange={(e) => setNewInterestRole(e.target.value)}
            className="flex-1 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-somni-pink focus:outline-none"
          >
            <option value="">Select role...</option>
            {roles
              .filter((r) => r.name !== '@everyone')
              .sort((a, b) => b.position - a.position)
              .map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
          </select>
          <button
            onClick={addInterestMapping}
            disabled={!newInterestName.trim() || !newInterestRole}
            className="rounded-md bg-somni-pink px-4 py-2 text-sm font-medium text-white hover:bg-somni-pink/80 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>

      {/* Native Onboarding Prompts (synced to Discord) */}
      {config.onboarding_enabled && (
        <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
          <h2 className="text-lg font-semibold text-discord-text-primary">
            Onboarding Prompts
          </h2>
          <p className="mt-1 text-sm text-discord-text-muted">
            These prompts are synced to Discord&apos;s native Guild Onboarding screen.
            New members see these when they first join the server.
          </p>

          <div className="mt-4 space-y-3">
            {(config.onboarding_config?.prompts ?? []).map((prompt, pIdx) => (
              <div
                key={pIdx}
                className="rounded border border-discord-border bg-discord-bg-tertiary p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <input
                    type="text"
                    value={prompt.title}
                    onChange={(e) => {
                      const prompts = [...(config.onboarding_config?.prompts ?? [])];
                      prompts[pIdx] = { ...prompts[pIdx], title: e.target.value };
                      setConfig((prev) => ({
                        ...prev,
                        onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                      }));
                    }}
                    placeholder="Prompt title..."
                    className="flex-1 rounded-md border border-discord-border bg-discord-bg-primary px-3 py-1.5 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      const prompts = (config.onboarding_config?.prompts ?? []).filter((_, i) => i !== pIdx);
                      setConfig((prev) => ({
                        ...prev,
                        onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                      }));
                    }}
                    className="ml-2 text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>

                <div className="flex items-center gap-4 text-xs text-discord-text-muted">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={prompt.required}
                      onChange={(e) => {
                        const prompts = [...(config.onboarding_config?.prompts ?? [])];
                        prompts[pIdx] = { ...prompts[pIdx], required: e.target.checked };
                        setConfig((prev) => ({
                          ...prev,
                          onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                        }));
                      }}
                      className="h-3.5 w-3.5 rounded accent-somni-pink"
                    />
                    Required
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={prompt.single_select}
                      onChange={(e) => {
                        const prompts = [...(config.onboarding_config?.prompts ?? [])];
                        prompts[pIdx] = { ...prompts[pIdx], single_select: e.target.checked };
                        setConfig((prev) => ({
                          ...prev,
                          onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                        }));
                      }}
                      className="h-3.5 w-3.5 rounded accent-somni-pink"
                    />
                    Single select
                  </label>
                  <select
                    value={prompt.type}
                    onChange={(e) => {
                      const prompts = [...(config.onboarding_config?.prompts ?? [])];
                      prompts[pIdx] = { ...prompts[pIdx], type: e.target.value as 'multiple_choice' | 'dropdown' };
                      setConfig((prev) => ({
                        ...prev,
                        onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                      }));
                    }}
                    className="rounded border border-discord-border bg-discord-bg-primary px-2 py-0.5 text-xs text-discord-text-primary"
                  >
                    <option value="multiple_choice">Multiple Choice</option>
                    <option value="dropdown">Dropdown</option>
                  </select>
                </div>

                {/* Options */}
                <div className="space-y-1.5 pl-2">
                  {prompt.options.map((opt, oIdx) => (
                    <div key={oIdx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={opt.title}
                        onChange={(e) => {
                          const prompts = [...(config.onboarding_config?.prompts ?? [])];
                          const options = [...prompts[pIdx].options];
                          options[oIdx] = { ...options[oIdx], title: e.target.value };
                          prompts[pIdx] = { ...prompts[pIdx], options };
                          setConfig((prev) => ({
                            ...prev,
                            onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                          }));
                        }}
                        placeholder="Option title..."
                        className="flex-1 rounded border border-discord-border bg-discord-bg-primary px-2 py-1 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
                      />
                      <button
                        onClick={() => {
                          const prompts = [...(config.onboarding_config?.prompts ?? [])];
                          prompts[pIdx] = {
                            ...prompts[pIdx],
                            options: prompts[pIdx].options.filter((_, i) => i !== oIdx),
                          };
                          setConfig((prev) => ({
                            ...prev,
                            onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                          }));
                        }}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      const prompts = [...(config.onboarding_config?.prompts ?? [])];
                      prompts[pIdx] = {
                        ...prompts[pIdx],
                        options: [...prompts[pIdx].options, { title: '' }],
                      };
                      setConfig((prev) => ({
                        ...prev,
                        onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                      }));
                    }}
                    className="text-xs text-somni-cyan hover:text-somni-cyan/80"
                  >
                    + Add Option
                  </button>
                </div>
              </div>
            ))}

            <button
              onClick={() => {
                const prompts = [...(config.onboarding_config?.prompts ?? []), {
                  title: '',
                  type: 'multiple_choice' as const,
                  required: false,
                  single_select: false,
                  options: [],
                }];
                setConfig((prev) => ({
                  ...prev,
                  onboarding_config: { ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }), prompts },
                }));
              }}
              className="rounded-md bg-somni-pink/10 px-4 py-2 text-sm font-medium text-somni-pink hover:bg-somni-pink/20"
            >
              + Add Prompt
            </button>
          </div>
        </section>
      )}

      {/* Returning Members */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          Returning Members
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          When a previously-known member rejoins, the bot can automatically restore their
          roles and skip certain welcome steps.
        </p>

        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={config.returning_member_skip_welcome_dm}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  returning_member_skip_welcome_dm: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-discord-border bg-discord-bg-tertiary accent-somni-pink"
            />
            <span className="text-sm text-discord-text-primary">
              Skip welcome DM for returning members
            </span>
          </label>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={config.returning_member_restore_entitlements}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  returning_member_restore_entitlements: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-discord-border bg-discord-bg-tertiary accent-somni-pink"
            />
            <span className="text-sm text-discord-text-primary">
              Auto-restore entitlement roles (purchases, subscriptions)
            </span>
          </label>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={config.returning_member_restore_levels}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  returning_member_restore_levels: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-discord-border bg-discord-bg-tertiary accent-somni-pink"
            />
            <span className="text-sm text-discord-text-primary">
              Auto-restore level reward roles
            </span>
          </label>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-somni-pink px-6 py-2.5 text-sm font-semibold text-white hover:bg-somni-pink/80 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
