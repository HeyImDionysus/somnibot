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
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';

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
  fallback_mode: 'grant-after-timeout' | 'manual-review';
  fallback_timeout_minutes: number;
  onboarding_config: NativeOnboardingConfig | null;
}

interface OnboardingSyncState {
  status: 'idle' | 'pending' | 'synced' | 'drifted' | 'failed';
  request_id?: string;
  observed_at?: string;
  error?: string;
  live_config?: NativeOnboardingConfig;
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
  fallback_mode: 'grant-after-timeout',
  fallback_timeout_minutes: 10,
  onboarding_config: null,
};

function selectedIds(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

export default function OnboardingPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<OnboardingConfig>(DEFAULT_CONFIG);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty);
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<OnboardingSyncState>({ status: 'idle' });

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
          const {
            onboarding_sync_state: loadedSyncState,
            ...loadedConfig
          } = configJson.data as OnboardingConfig & {
            onboarding_sync_state?: OnboardingSyncState;
          };
          setConfig({ ...DEFAULT_CONFIG, ...loadedConfig });
          setSyncState(loadedSyncState ?? { status: 'idle' });
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
      if (json.sync) setSyncState(json.sync as OnboardingSyncState);
      if (!json.success) {
        if (json.saved) setDirty(false);
        throw new Error(json.error);
      }
      setDirty(false);

      const requestId = (json.sync as OnboardingSyncState).request_id;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const statusResponse = await fetch('/api/onboarding', { cache: 'no-store' });
        const statusJson = await statusResponse.json();
        const nextSync = statusJson.data?.onboarding_sync_state as OnboardingSyncState | undefined;
        if (!statusJson.success || !nextSync || nextSync.request_id !== requestId) continue;
        setSyncState(nextSync);
        if (nextSync.status === 'pending' || nextSync.status === 'idle') continue;
        if (nextSync.status === 'synced') {
          toast({ title: 'Settings saved and verified in Discord', variant: 'success' });
          return;
        }
        if (nextSync.status === 'drifted') {
          const message = 'Discord accepted a different onboarding state. Review the authoritative readback below.';
          setError(message);
          toast({ title: message, variant: 'error' });
          return;
        }
        const message = nextSync.error ?? 'Discord rejected the onboarding synchronization.';
        setError(message);
        toast({ title: message, variant: 'error' });
        return;
      }

      toast({ title: 'Settings saved; Discord synchronization is still pending', variant: 'success' });
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

  const updatePromptOption = (
    promptIndex: number,
    optionIndex: number,
    updates: Partial<OnboardingPromptOption>,
  ) => {
    setConfig((prev) => {
      const onboardingConfig = prev.onboarding_config ?? {
        enabled: true,
        prompts: [],
        default_channel_ids: [],
      };
      const prompts = [...onboardingConfig.prompts];
      const options = [...prompts[promptIndex].options];
      options[optionIndex] = { ...options[optionIndex], ...updates };
      prompts[promptIndex] = { ...prompts[promptIndex], options };
      return {
        ...prev,
        onboarding_config: { ...onboardingConfig, prompts },
      };
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
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
            🔒
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-medium text-discord-text-primary">
              @everyone Permissions
            </h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              @everyone is set to <strong className="text-red-400">zero permissions</strong>. This is by design
              and cannot be changed. New members see only the Discord onboarding screen until they
              complete it and receive the Member role.
            </p>
            <div className="mt-3 rounded border border-discord-border-subtle bg-discord-bg-tertiary px-4 py-2 text-xs text-discord-text-muted">
              All permissions come from the Member role and above. @everyone = 0 ensures
              unverified members cannot access any channels.
            </div>
          </div>
        </div>
      </section>

      {/* Discord Onboarding Toggle */}
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-discord-text-primary">
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
                setConfig((prev) => ({
                  ...prev,
                  onboarding_enabled: e.target.checked,
                  onboarding_config: prev.onboarding_config
                    ? { ...prev.onboarding_config, enabled: e.target.checked }
                    : null,
                }))
              }
            />
            <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
          </label>
        </div>
        {syncState.status !== 'idle' && (
          <div
            className={`mt-4 rounded-md border px-4 py-3 text-sm ${
              syncState.status === 'synced'
                ? 'border-green-500/30 bg-green-500/10 text-green-300'
                : syncState.status === 'pending'
                  ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200'
                  : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
            role={syncState.status === 'failed' || syncState.status === 'drifted' ? 'alert' : 'status'}
          >
            {syncState.status === 'pending' && 'Saved. Waiting for the bot to apply and read back Discord onboarding.'}
            {syncState.status === 'synced' && (
              `Verified in Discord: ${syncState.live_config?.prompts.length ?? 0} prompts and ${syncState.live_config?.default_channel_ids.length ?? 0} default channels.`
            )}
            {syncState.status === 'drifted' && (
              `Discord differs from the saved request: ${syncState.live_config?.prompts.length ?? 0} live prompts and ${syncState.live_config?.default_channel_ids.length ?? 0} live default channels.`
            )}
            {syncState.status === 'failed' && (syncState.error ?? 'Discord synchronization failed.')}
          </div>
        )}
      </section>

      {/* Member Role Selection */}
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-medium text-discord-text-primary">
          Member Role
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          The role granted when a member completes onboarding. This unlocks channel access.
        </p>
        <select
          className="mt-3 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
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
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-medium text-discord-text-primary">
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
                  className="flex items-center justify-between rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2"
                >
                  <span className="text-sm text-discord-text-primary">
                    &quot;{name}&quot; → <span className="text-discord-accent">{role?.name ?? roleId}</span>
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
            className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none"
          />
          <select
            value={newInterestRole}
            onChange={(e) => setNewInterestRole(e.target.value)}
            className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
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
            className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>

      {/* Native Onboarding Prompts (synced to Discord) */}
      {config.onboarding_enabled && (
        <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
          <h2 className="text-lg font-medium text-discord-text-primary">
            Onboarding Prompts
          </h2>
          <p className="mt-1 text-sm text-discord-text-muted">
            These prompts are synced to Discord&apos;s native Guild Onboarding screen.
            New members see these when they first join the server.
          </p>

          <ChannelPicker
            multi
            value={config.onboarding_config?.default_channel_ids ?? []}
            onChange={(value) => setConfig((prev) => ({
              ...prev,
              onboarding_config: {
                ...(prev.onboarding_config ?? { enabled: true, prompts: [], default_channel_ids: [] }),
                default_channel_ids: selectedIds(value),
              },
            }))}
            label="Default channels"
            hint="Channels every new member receives through Discord onboarding. SomniBot never creates or exposes channels automatically."
            placeholder="Select existing Discord channels"
            className="mt-4"
          />

          <div className="mt-4 space-y-3">
            {(config.onboarding_config?.prompts ?? []).map((prompt, pIdx) => (
              <div
                key={pIdx}
                className="rounded border border-discord-border-subtle bg-discord-bg-tertiary p-4 space-y-3"
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
                    className="flex-1 rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-1.5 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none"
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
                      className="h-3.5 w-3.5 rounded accent-discord-accent"
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
                      className="h-3.5 w-3.5 rounded accent-discord-accent"
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
                    className="rounded border border-discord-border-subtle bg-discord-bg-primary px-2 py-0.5 text-xs text-discord-text-primary"
                  >
                    <option value="multiple_choice">Multiple Choice</option>
                    <option value="dropdown">Dropdown</option>
                  </select>
                </div>

                {/* Options */}
                <div className="space-y-1.5 pl-2">
                  {prompt.options.map((opt, oIdx) => (
                    <div key={oIdx} className="rounded border border-discord-border-subtle p-3">
                      <div className="flex items-center gap-2">
                        <input
                        type="text"
                        value={opt.title}
                        onChange={(e) => updatePromptOption(pIdx, oIdx, { title: e.target.value })}
                        placeholder="Option title..."
                        className="flex-1 rounded border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-xs text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none"
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
                      <div className="grid gap-3 pt-2 sm:grid-cols-2">
                        <RolePicker
                          multi
                          value={opt.role_ids ?? []}
                          onChange={(value) => updatePromptOption(pIdx, oIdx, {
                            role_ids: selectedIds(value),
                          })}
                          label="Roles granted"
                          placeholder="No roles"
                          hideEveryone
                          requireAssignable
                        />
                        <ChannelPicker
                          multi
                          value={opt.channel_ids ?? []}
                          onChange={(value) => updatePromptOption(pIdx, oIdx, {
                            channel_ids: selectedIds(value),
                          })}
                          label="Channels added"
                          placeholder="No channels"
                        />
                      </div>
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
                    className="text-xs text-discord-accent hover:text-discord-accent/80"
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
              className="rounded-md bg-discord-accent/10 px-4 py-2 text-sm font-medium text-discord-accent hover:bg-discord-accent/20"
            >
              + Add Prompt
            </button>
          </div>
        </section>
      )}

      {/* Returning Members */}
      <section className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-medium text-discord-text-primary">
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
              className="h-4 w-4 rounded border-discord-border-subtle bg-discord-bg-tertiary accent-discord-accent"
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
              className="h-4 w-4 rounded border-discord-border-subtle bg-discord-bg-tertiary accent-discord-accent"
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
              className="h-4 w-4 rounded border-discord-border-subtle bg-discord-bg-tertiary accent-discord-accent"
            />
            <span className="text-sm text-discord-text-primary">
              Auto-restore level reward roles
            </span>
          </label>
        </div>
        <div className="mt-6 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary p-4">
          <h3 className="text-sm font-semibold text-discord-text-primary">Safe fallback</h3>
          <p className="mt-1 text-xs text-discord-text-muted">Recover members when DMs are closed or native onboarding is unavailable.</p>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-discord-text-primary">
            <label>Mode <select value={config.fallback_mode} onChange={(e) => { setConfig((prev) => ({ ...prev, fallback_mode: e.target.value as OnboardingConfig['fallback_mode'] })); setDirty(true); }} className="ml-2 rounded bg-discord-bg-secondary px-2 py-1"><option value="grant-after-timeout">Grant after timeout</option><option value="manual-review">Manual review</option></select></label>
            <label>Timeout (minutes) <input type="number" min={1} max={1440} value={config.fallback_timeout_minutes} onChange={(e) => { setConfig((prev) => ({ ...prev, fallback_timeout_minutes: Number(e.target.value) })); setDirty(true); }} className="ml-2 w-20 rounded bg-discord-bg-secondary px-2 py-1" /></label>
          </div>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-discord-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
        >
          {saving ? 'Saving and syncing...' : 'Save Changes'}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
