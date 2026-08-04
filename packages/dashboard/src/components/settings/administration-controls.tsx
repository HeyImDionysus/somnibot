'use client';

import { useEffect, useState } from 'react';
import { Lock, Loader2, Save, SlidersHorizontal, Server } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { useToast } from '@/components/shared/toast';

type ControlValue = string | number | boolean;
type GuildControls = Record<string, ControlValue>;

const GUILD_CONTROLS: Array<{ key: string; label: string; type: 'number' | 'boolean' | 'select'; min?: number; max?: number; options?: string[] }> = [
  { key: 'audit_export_row_limit', label: 'Audit export row limit', type: 'number', min: 1, max: 100000 },
  { key: 'audit_flush_interval_ms', label: 'Audit flush interval (ms)', type: 'number', min: 1000, max: 60000 },
  { key: 'automation_dm_cooldown_seconds', label: 'Automation DM cooldown (seconds)', type: 'number', min: 0, max: 86400 },
  { key: 'automation_max_chain_depth', label: 'Automation max chain depth', type: 'number', min: 1, max: 10 },
  { key: 'automation_preview_required', label: 'Require automation preview', type: 'boolean' },
  { key: 'automation_user_fire_limit_per_minute', label: 'Automation user fire limit / minute', type: 'number', min: 1, max: 100 },
  { key: 'custom_commands_max_per_guild', label: 'Custom commands per guild', type: 'number', min: 1, max: 10000 },
  { key: 'diagnostics_snapshot_interval_ms', label: 'Diagnostics snapshot interval (ms)', type: 'number', min: 10000, max: 3600000 },
  { key: 'incidents_auto_create_from_critical_alerts', label: 'Auto-create incidents from critical alerts', type: 'boolean' },
  { key: 'incidents_default_severity', label: 'Default incident severity', type: 'select', options: ['info', 'warning', 'critical', 'outage'] },
  { key: 'incidents_list_page_size', label: 'Incident list page size', type: 'number', min: 1, max: 100 },
  { key: 'rbac_custom_role_priority_default', label: 'Default custom-role priority', type: 'number', min: 0, max: 999 },
  { key: 'rbac_max_permissions_per_role', label: 'Max permissions per role', type: 'number', min: 1, max: 500 },
];

const LOCKED_CONTROLS = [
  ['custom_commands_mention_safety', 'Enabled — locked'],
  ['rbac_priority_escalation_guard', 'Enabled — locked'],
  ['rbac_unknown_route_access', 'Deny — locked'],
] as const;

const INSTALLATION_CONTROLS: Array<{ key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select'; options?: string[] }> = [
  { key: 'auto_install_on_quit', label: 'Install updates when quitting', type: 'boolean' },
  { key: 'keychain_required', label: 'Require OS keychain', type: 'boolean' },
  { key: 'lavalink_enabled', label: 'Enable Lavalink', type: 'boolean' },
  { key: 'owner_brand_name', label: 'Owner / brand name', type: 'text' },
  { key: 'runtime_mode', label: 'Runtime mode', type: 'select', options: ['regular-local', 'vps', 'development'] },
  { key: 'update_prompt_before_download', label: 'Prompt before downloading updates', type: 'boolean' },
  { key: 'vps_deploy_path', label: 'VPS deploy path', type: 'text' },
  { key: 'sdk_cache_ttl_ms', label: 'SDK cache TTL (ms)', type: 'number' },
];

export function AdministrationControls() {
  const { toast } = useToast();
  const [guild, setGuild] = useState<GuildControls>({});
  const [installation, setInstallation] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([fetch('/api/guild'), fetch('/api/settings')])
      .then(async ([guildRes, settingsRes]) => {
        const guildJson = await guildRes.json();
        const settingsJson = await settingsRes.json();
        setGuild(guildJson.config || {});
        setInstallation(settingsJson.values || {});
      })
      .catch(() => toast({ title: 'Failed to load administration controls', variant: 'error' }))
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    setSaving(true);
    try {
      const guildPayload: Record<string, ControlValue> = {};
      for (const control of GUILD_CONTROLS) {
        if (guild[control.key] !== undefined) guildPayload[control.key] = guild[control.key];
      }
      const guildRes = await fetch('/api/guild', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guildPayload) });
      if (!guildRes.ok) throw new Error('guild');
      const installationValues: Record<string, string> = {};
      for (const control of INSTALLATION_CONTROLS) {
        const value = installation[control.key];
        if (value !== undefined && value !== '') installationValues[control.key] = value;
      }
      if (Object.keys(installationValues).length > 0) {
        const settingsRes = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: 'administration', values: installationValues }) });
        if (!settingsRes.ok) throw new Error('settings');
      }
      toast({ title: 'Administration controls saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save administration controls', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card><div className="flex items-center gap-2 p-6 text-sm text-discord-text-muted"><Loader2 size={16} className="animate-spin" /> Loading administration controls...</div></Card>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3"><SlidersHorizontal size={20} className="text-discord-accent" /><div><CardTitle className="text-base">Administration controls</CardTitle><CardDescription>Owner-editable operational limits and defaults. Values are validated before persistence.</CardDescription></div></div>
        </CardHeader>
        <div className="grid gap-4 px-6 pb-6 md:grid-cols-2">
          {GUILD_CONTROLS.map((control) => (
            <label key={control.key} className="space-y-1 text-sm text-discord-text-secondary">
              <span>{control.label}</span>
              {control.type === 'boolean' ? <input type="checkbox" checked={Boolean(guild[control.key])} onChange={(e) => setGuild((v) => ({ ...v, [control.key]: e.target.checked }))} /> : control.type === 'select' ? <select value={String(guild[control.key] ?? control.options?.[0] ?? '')} onChange={(e) => setGuild((v) => ({ ...v, [control.key]: e.target.value }))} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm">{control.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input type="number" min={control.min} max={control.max} value={Number(guild[control.key] ?? 0)} onChange={(e) => setGuild((v) => ({ ...v, [control.key]: Number(e.target.value) }))} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm" />}
            </label>
          ))}
          {LOCKED_CONTROLS.map(([key, value]) => <div key={key} className="space-y-1 text-sm text-discord-text-secondary"><span className="flex items-center gap-1"><Lock size={12} /> {key}</span><input value={value} readOnly disabled className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm opacity-60" /></div>)}
        </div>
      </Card>
      <Card>
        <CardHeader><div className="flex items-center gap-3"><Server size={20} className="text-discord-accent" /><div><CardTitle className="text-base">Launcher and infrastructure</CardTitle><CardDescription>Installation-wide runtime settings used by the launcher, updater, and SDK.</CardDescription></div></div></CardHeader>
        <div className="grid gap-4 px-6 pb-6 md:grid-cols-2">
          {INSTALLATION_CONTROLS.map((control) => <label key={control.key} className="space-y-1 text-sm text-discord-text-secondary"><span>{control.label}</span>{control.type === 'boolean' ? <input type="checkbox" checked={installation[control.key] !== 'false'} onChange={(e) => setInstallation((v) => ({ ...v, [control.key]: String(e.target.checked) }))} /> : control.type === 'select' ? <select value={installation[control.key] || control.options?.[0] || ''} onChange={(e) => setInstallation((v) => ({ ...v, [control.key]: e.target.value }))} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm">{control.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input type={control.type} value={installation[control.key] || ''} onChange={(e) => setInstallation((v) => ({ ...v, [control.key]: e.target.value }))} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm" />}</label>)}
        </div>
        <div className="flex justify-end px-6 pb-6"><Button onClick={save} disabled={saving} className="gap-2">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save administration controls</Button></div>
      </Card>
    </div>
  );
}
