'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Copy, RotateCcw } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';
import { Input, Select } from '@/components/shared/input';
import {
  buildLicensingPromptEnvelope,
  renderLicensingPrompt,
  type LicensingPromptDraft,
  type LicensingPromptMode,
} from '@/lib/store/licensing-prompt';
import {
  LICENSING_STORE_HANDOFF_KEY,
  savedProductToLicensingDraft,
  serializeLicensingStoreHandoff,
} from '@/lib/store/licensing-handoff';

const INITIAL_DRAFT: LicensingPromptDraft = {
  mode: 'dynamic',
  projectName: '',
  projectContext: '',
  productId: '',
  apiBase: 'CONFIGURE_SOMNIBOT_API_BASE',
  billingModel: 'undecided',
  plansAndFeatures: '',
  featureFlags: '',
  outputFormats: '',
  installationIdentity: 'One stable installation, deployment, tenant, server, or device identity',
  maxInstallations: 3,
  heartbeatSeconds: 300,
  offlineGraceSeconds: 86400,
};

const LICENSING_MODES: readonly LicensingPromptMode[] = ['dynamic', 'static'];

const onboardingResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ apiBase: z.string().url(), guildId: z.string().min(1) }),
});

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
  const [loadMessage, setLoadMessage] = useState('');
  const [handoffError, setHandoffError] = useState('');
  const [authoritativeLoading, setAuthoritativeLoading] = useState(true);
  const [activeGuildId, setActiveGuildId] = useState('');

  useEffect(() => {
    const fallbackApiBase = `${window.location.origin.replace(/\/$/, '')}/api`;
    const productId = new URLSearchParams(window.location.search).get('productId')?.trim();
    let cancelled = false;
    const loadProduct = async () => {
      setDraft((current) => ({ ...current, apiBase: fallbackApiBase }));
      try {
        const onboardingResponse = await fetch('/api/store/onboarding');
        const onboardingBody = onboardingResponseSchema.safeParse(await onboardingResponse.json());
        const apiBase = onboardingResponse.ok && onboardingBody.success
          ? onboardingBody.data.data.apiBase
          : fallbackApiBase;
        if (onboardingResponse.ok && onboardingBody.success && !cancelled) {
          setActiveGuildId(onboardingBody.data.data.guildId);
        }
        if (!productId) {
          if (!cancelled) setDraft((current) => ({ ...current, apiBase }));
          return;
        }
        if (!onboardingResponse.ok || !onboardingBody.success) {
          throw new Error('invalid onboarding response');
        }
        const productResponse = await fetch('/api/store/products');
        const body: unknown = await productResponse.json();
        if (!productResponse.ok || typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
          throw new Error('invalid product response');
        }
        const product = body.data.find((candidate) => (
          typeof candidate === 'object'
          && candidate !== null
          && 'id' in candidate
          && candidate.id === productId
        ));
        if (!product) throw new Error('product not found');
        const savedDraft = savedProductToLicensingDraft(product, apiBase);
        if (!cancelled) {
          setDraft(savedDraft);
          setLoadMessage(`Loaded authoritative Store product ${savedDraft.projectName}. Review the completed-project context before copying.`);
        }
      } catch {
        if (!cancelled) setLoadMessage('The saved Store product or license policy could not be loaded. Manual prompt generation remains available.');
      } finally {
        if (!cancelled) setAuthoritativeLoading(false);
      }
    };
    void loadProduct();
    return () => { cancelled = true; };
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
    setLoadMessage('');
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const useInStore = () => {
    try {
      const envelope = buildLicensingPromptEnvelope(draft);
      window.sessionStorage.setItem(
        LICENSING_STORE_HANDOFF_KEY,
        serializeLicensingStoreHandoff(envelope, activeGuildId, undefined, crypto.randomUUID()),
      );
      setHandoffError('');
      window.location.assign('/store?licensingHandoff=1');
    } catch {
      setHandoffError('This browser could not keep the temporary Store handoff. Check session storage access and try again.');
    }
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
      <fieldset disabled={authoritativeLoading} aria-labelledby="prompt-input-heading" aria-busy={authoritativeLoading} className="space-y-5 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5 disabled:opacity-70">
        <div>
          <h2 id="prompt-input-heading" className="text-lg font-semibold text-discord-text-primary">Describe the completed project</h2>
          <p className="mt-1 text-sm text-discord-text-secondary">Attach SomniBot licensing to an existing repository without redesigning or rebuilding the project.</p>
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

        {authoritativeLoading && <p className="rounded-input border border-discord-accent/40 bg-discord-accent/10 p-3 text-sm text-discord-text-secondary" role="status">Loading the authoritative Store product and public API base…</p>}
        {loadMessage && <p className={`rounded-input border p-3 text-sm ${loadMessage.startsWith('Loaded') ? 'border-discord-success/40 bg-discord-success/10 text-discord-success' : 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger'}`} role={loadMessage.startsWith('Loaded') ? 'status' : 'alert'}>{loadMessage}</p>}
        <Input label="Project name" value={draft.projectName} onChange={(event) => update('projectName', event.target.value)} placeholder="SafePaste" />
        <TextAreaField id="licensing-project-context" label="Completed project context" value={draft.projectContext} onChange={(value) => update('projectContext', value)} placeholder="Describe the existing repository, behavior, language, runtime, packaging, deployment, licensed capabilities, and everything the licensing change must preserve." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select id="licensing-billing-model" label="Billing model" value={draft.billingModel} onChange={(event) => {
            const value = event.target.value;
            if (value === 'one_time' || value === 'subscription' || value === 'multiple' || value === 'free' || value === 'undecided') {
              update('billingModel', value);
            }
          }} options={[
            { value: 'undecided', label: 'Decide during Store setup' },
            { value: 'one_time', label: 'One-time purchase' },
            { value: 'subscription', label: 'Subscription' },
            { value: 'multiple', label: 'Multiple plans' },
            { value: 'free', label: 'Free claim' },
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
              <Input label="Max installations" type="number" min={1} max={100} value={draft.maxInstallations} onChange={(event) => update('maxInstallations', Math.max(1, Math.min(100, Number(event.target.value))))} />
              <Input label="Heartbeat seconds" type="number" min={60} max={86400} value={draft.heartbeatSeconds} onChange={(event) => update('heartbeatSeconds', Math.max(60, Math.min(86400, Number(event.target.value))))} />
              <Input label="Offline grace seconds" type="number" min={0} max={604800} value={draft.offlineGraceSeconds} onChange={(event) => update('offlineGraceSeconds', Math.max(0, Math.min(604800, Number(event.target.value))))} />
            </div>
            <Input label="Structured feature flags" value={draft.featureFlags} onChange={(event) => update('featureFlags', event.target.value)} placeholder="pro-mode, exports" />
          </div>
        ) : (
          <TextAreaField id="licensing-output-formats" label="Output formats" value={draft.outputFormats} onChange={(value) => update('outputFormats', value)} placeholder="List every delivered format, including future variants that need a verified buyer-derivative transformer." />
        )}
      </fieldset>

      <section aria-labelledby="generated-prompt-heading" className="self-start rounded-card border border-discord-accent/40 bg-discord-bg-secondary p-5 xl:sticky xl:top-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="generated-prompt-heading" className="text-lg font-semibold text-discord-text-primary">Generated implementation prompt</h2>
            <p className="mt-1 text-sm text-discord-text-secondary">Nothing is saved on the server. Copy the contract or privately hand it to Store for product setup in this tab.</p>
          </div>
          <span className="rounded-full bg-discord-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-discord-accent">Stateless</span>
        </div>
        {!requiredReady && <p className="mt-4 rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3 text-xs text-discord-warning" role="status">Add a project name, a real project description, and every static output format before copying.</p>}
        {copyError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{copyError}</p>}
        {handoffError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{handoffError}</p>}
        <pre className="mt-4 max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-input bg-discord-bg-floating p-4 text-xs leading-5 text-discord-text-secondary"><code>{prompt}</code></pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy()} disabled={!requiredReady || authoritativeLoading}><Copy size={16} aria-hidden="true" />{copied ? 'Prompt copied' : 'Copy prompt'}</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={useInStore}
            disabled={!requiredReady || authoritativeLoading || !activeGuildId || Boolean(draft.productId)}
            title={draft.productId ? 'This prompt already comes from an authoritative saved product' : undefined}
          >
            <ArrowRight size={16} aria-hidden="true" />Use in Store
          </Button>
          <Button type="button" variant="secondary" onClick={clear} disabled={authoritativeLoading}><RotateCcw size={16} aria-hidden="true" />Clear</Button>
        </div>
      </section>
    </div>
  );
}
