'use client';

import { useEffect, useMemo, useState } from 'react';
import { Copy, RotateCcw } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import {
  buildLicensingPromptEnvelope,
  renderLicensingPrompt,
  type LicensingPromptDraft,
  type LicensingPromptMode,
} from '@/lib/store/licensing-prompt';

const INITIAL_DRAFT: LicensingPromptDraft = {
  mode: 'dynamic',
  projectName: '',
  projectContext: '',
  productId: '',
  apiBase: 'CONFIGURE_SOMNIBOT_API_BASE',
  billingModel: 'undecided',
  plansAndFeatures: '',
  outputFormats: '',
  installationIdentity: 'One stable installation, deployment, tenant, server, or device identity',
  maxInstallations: 1,
  heartbeatSeconds: 300,
  offlineGraceSeconds: 86400,
  requireDiscordMembership: false,
};

const LICENSING_MODES: readonly LicensingPromptMode[] = ['dynamic', 'static'];

function modeButtonClass(active: boolean): string {
  return active
    ? 'border-discord-accent bg-discord-accent/15 text-discord-text-primary'
    : 'border-discord-border-subtle bg-discord-bg-tertiary text-discord-text-secondary hover:border-discord-border-strong';
}

function TextAreaField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-input border border-transparent bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted/60 focus:border-discord-accent focus:outline-none"
      />
    </div>
  );
}

export function LicensingPromptGenerator() {
  const [draft, setDraft] = useState<LicensingPromptDraft>(INITIAL_DRAFT);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      apiBase: `${window.location.origin.replace(/\/$/, '')}/api`,
    }));
  }, []);

  const prompt = useMemo(
    () => renderLicensingPrompt(buildLicensingPromptEnvelope(draft)),
    [draft],
  );
  const requiredReady = draft.projectName.trim().length > 0
    && draft.projectContext.trim().length > 0
    && (draft.mode === 'dynamic' || draft.outputFormats.trim().length > 0);

  const update = <Key extends keyof LicensingPromptDraft>(
    key: Key,
    value: LicensingPromptDraft[Key],
  ) => {
    setCopied(false);
    setCopyError('');
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const selectMode = (mode: LicensingPromptMode) => {
    setCopied(false);
    update('mode', mode);
  };
  const clear = () => {
    setDraft({ ...INITIAL_DRAFT, apiBase: draft.apiBase });
    setCopied(false);
    setCopyError('');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopied(false);
      setCopyError('Clipboard access was blocked. Allow clipboard access for this dashboard and try again.');
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <section aria-labelledby="prompt-input-heading" className="space-y-5 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <div>
          <h2 id="prompt-input-heading" className="text-lg font-semibold text-discord-text-primary">Describe the project licensing</h2>
          <p className="mt-1 text-sm text-discord-text-secondary">Choose only the licensing base. Your free-form description tells the implementer how to adapt it to the real project.</p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Licensing base</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Licensing base">
            {LICENSING_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={draft.mode === mode}
                onClick={() => selectMode(mode)}
                className={`min-h-20 rounded-input border p-3 text-left transition-standard ${modeButtonClass(draft.mode === mode)}`}
              >
                <span className="block text-sm font-semibold capitalize">{mode}</span>
                <span className="mt-1 block text-xs text-discord-text-muted">
                  {mode === 'dynamic' ? 'Running software validates and maintains entitlement.' : 'Files are protected at delivery with buyer-specific evidence.'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <Input label="Project name" value={draft.projectName} onChange={(event) => update('projectName', event.target.value)} placeholder="SafePaste" />
        <TextAreaField id="licensing-project-context" label="Project description" value={draft.projectContext} onChange={(value) => update('projectContext', value)} placeholder="Describe the real project, language, runtime, packaging, deployment, paid capabilities, and anything the implementer must preserve." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select id="licensing-billing-model" label="Billing model" value={draft.billingModel} onChange={(event) => {
            const value = event.target.value;
            if (value === 'one_time' || value === 'subscription' || value === 'multiple' || value === 'undecided') {
              update('billingModel', value);
            }
          }} options={[
            { value: 'undecided', label: 'Decide during Store setup' },
            { value: 'one_time', label: 'One-time purchase' },
            { value: 'subscription', label: 'Subscription' },
            { value: 'multiple', label: 'Multiple plans' },
          ]} />
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">SomniBot API base</p>
            <p className="break-all rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary">{draft.apiBase}</p>
            <p className="text-xs text-discord-text-muted">Set automatically from this dashboard deployment so the generated project cannot point at a different licensing server.</p>
          </div>
        </div>
        <TextAreaField id="licensing-plans-features" label="Plans and licensed capabilities" value={draft.plansAndFeatures} onChange={(value) => update('plansAndFeatures', value)} placeholder="Describe planned editions, features, content, limits, or leave blank until Store setup." />

        {draft.mode === 'dynamic' ? (
          <div className="space-y-4 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
            <Input label="Installation identity" value={draft.installationIdentity} onChange={(event) => update('installationIdentity', event.target.value)} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="Max installations" type="number" min={1} value={draft.maxInstallations} onChange={(event) => update('maxInstallations', Math.max(1, Number(event.target.value)))} />
              <Input label="Heartbeat seconds" type="number" min={30} value={draft.heartbeatSeconds} onChange={(event) => update('heartbeatSeconds', Math.max(30, Number(event.target.value)))} />
              <Input label="Offline grace seconds" type="number" min={0} value={draft.offlineGraceSeconds} onChange={(event) => update('offlineGraceSeconds', Math.max(0, Number(event.target.value)))} />
            </div>
            <Toggle label="Require current Discord membership" description="Optional product policy, not proof of purchase." checked={draft.requireDiscordMembership} onChange={(checked) => update('requireDiscordMembership', checked)} />
          </div>
        ) : (
          <TextAreaField id="licensing-output-formats" label="Output formats" value={draft.outputFormats} onChange={(value) => update('outputFormats', value)} placeholder="List every delivered format, including future variants that need a verified buyer-derivative transformer." />
        )}
      </section>

      <section aria-labelledby="generated-prompt-heading" className="self-start rounded-card border border-discord-accent/40 bg-discord-bg-secondary p-5 xl:sticky xl:top-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="generated-prompt-heading" className="text-lg font-semibold text-discord-text-primary">Generated implementation prompt</h2>
            <p className="mt-1 text-sm text-discord-text-secondary">Nothing on this page is saved. Copy the prompt into a project brief, then create the sellable product separately in Store.</p>
          </div>
          <span className="rounded-full bg-discord-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-discord-accent">Stateless</span>
        </div>
        {!requiredReady && <p className="mt-4 rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3 text-xs text-discord-warning" role="status">Add a project name, a real project description, and every static output format before copying.</p>}
        {copyError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{copyError}</p>}
        <pre className="mt-4 max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-input bg-discord-bg-floating p-4 text-xs leading-5 text-discord-text-secondary"><code>{prompt}</code></pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy()} disabled={!requiredReady}><Copy size={16} aria-hidden="true" />{copied ? 'Prompt copied' : 'Copy prompt'}</Button>
          <Button type="button" variant="secondary" onClick={clear}><RotateCcw size={16} aria-hidden="true" />Clear</Button>
        </div>
      </section>
    </div>
  );
}
