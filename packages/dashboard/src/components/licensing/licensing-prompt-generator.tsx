'use client';

// allow: SIZE_OK — cohesive SDK editor state, validation, and four-file preview stay in one owned client surface.

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Copy, Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';
import { Input, Select } from '@/components/shared/input';
import {
  buildLicensingPromptEnvelope,
  normalizeFeatureFlags,
  renderLicensingPrompt,
  type LicensingPromptDraft,
  type LicensingPromptMode,
} from '@/lib/store/licensing-prompt';
import { extractLicensingSdkBundle, type LicensingRails } from '@/lib/store/licensing-sdk-bundle';
import {
  licensingCapabilitiesSchema,
  normalizeLicensingCapabilities,
  type LicensingCapability,
} from '@/lib/store/licensing-capabilities';
import {
  LICENSING_STORE_HANDOFF_KEY,
  savedLicensingProductSchema,
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
const SDK_FILE_NAMES = ['AGENT.md', 'CONFORMANCE.md', 'license-api.openapi.json', 'somnibot-sdk.json'] as const;
type SdkFileName = (typeof SDK_FILE_NAMES)[number];
const INITIAL_RAILS: LicensingRails = {
  runtimeLicensing: true,
  downloadableFiles: false,
  hostedAccess: false,
  discordRoles: false,
  updates: false,
};

const RAIL_OPTIONS: readonly {
  readonly key: keyof LicensingRails;
  readonly label: string;
  readonly description: string;
}[] = [
  { key: 'runtimeLicensing', label: 'Runtime licensing', description: 'Validate, heartbeat, offline grace, and deactivate running installations.' },
  { key: 'downloadableFiles', label: 'Protected downloads', description: 'Authorize expiring delivery and buyer-specific file protection.' },
  { key: 'hostedAccess', label: 'Hosted access', description: 'Authorize server-hosted routes, services, or cloud operations.' },
  { key: 'discordRoles', label: 'Discord roles', description: 'Grant or remove Discord role benefits from entitlement state.' },
  { key: 'updates', label: 'Signed updates', description: 'Restrict update manifests and signed release downloads.' },
];

type EditableCapability = Omit<LicensingCapability, 'grantingPlans' | 'dependencyKeys'> & {
  readonly grantingPlansText: string;
  readonly grantingPlanIds: Readonly<Record<string, string>>;
  readonly dependencyKeysText: string;
};

const EMPTY_CAPABILITY: EditableCapability = {
  key: '',
  name: '',
  behavioralMeaning: '',
  controlledFunctionality: '',
  grantingPlansText: '',
  grantingPlanIds: {},
  unavailableBehavior: '',
  dependencyKeysText: '',
};

function capabilityToEditable(capability: LicensingCapability): EditableCapability {
  return {
    ...capability,
    grantingPlansText: capability.grantingPlans.map((plan) => `${plan.key}: ${plan.name}`).join(', '),
    grantingPlanIds: Object.fromEntries(capability.grantingPlans.flatMap((plan) => (
      plan.planId ? [[plan.key, plan.planId]] : []
    ))),
    dependencyKeysText: capability.dependencyKeys.join(', '),
  };
}

function parseCommaSeparated(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function editableCapabilities(value: readonly EditableCapability[]) {
  return licensingCapabilitiesSchema.safeParse(value.map((capability) => ({
    key: capability.key,
    name: capability.name,
    behavioralMeaning: capability.behavioralMeaning,
    controlledFunctionality: capability.controlledFunctionality,
    grantingPlans: parseCommaSeparated(capability.grantingPlansText).map((entry) => {
      const separator = entry.indexOf(':');
      const key = separator < 0 ? entry : entry.slice(0, separator).trim();
      const name = separator < 0 ? '' : entry.slice(separator + 1).trim();
      const planId = capability.grantingPlanIds[key];
      return planId ? { key, name, planId } : { key, name };
    }),
    unavailableBehavior: capability.unavailableBehavior,
    dependencyKeys: parseCommaSeparated(capability.dependencyKeysText),
  })));
}

function fileText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function downloadText(fileName: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

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
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
  readonly error?: string;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-full resize-y rounded-input border border-transparent bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted/60 focus:border-discord-accent focus:outline-none"
      />
      {error && <p id={errorId} className="text-xs text-discord-danger">{error}</p>}
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
  const [capabilities, setCapabilities] = useState<EditableCapability[]>([]);
  const [selectedFile, setSelectedFile] = useState<SdkFileName>('somnibot-sdk.json');
  const [copiedFile, setCopiedFile] = useState<SdkFileName | null>(null);
  const [rails, setRails] = useState<LicensingRails>(INITIAL_RAILS);
  const [prompt, setPrompt] = useState('');
  const [generatingBundle, setGeneratingBundle] = useState(true);
  const [generationError, setGenerationError] = useState('');

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
        const savedDraft = await savedProductToLicensingDraft(product, apiBase);
        const savedProduct = savedLicensingProductSchema.parse(product);
        const savedCapabilities = savedProduct.metadata.completed_project_licensing?.capabilities;
        const normalizedCapabilities = normalizeLicensingCapabilities(
          savedDraft.mode === 'dynamic' ? normalizeFeatureFlags(savedDraft.featureFlags) : [],
          savedCapabilities && savedCapabilities.length > 0 ? savedCapabilities : undefined,
        );
        if (!cancelled) {
          setDraft(savedDraft);
          setCapabilities(normalizedCapabilities.map(capabilityToEditable));
          setRails(savedDraft.rails ?? (savedDraft.mode === 'dynamic'
            ? INITIAL_RAILS
            : { ...INITIAL_RAILS, runtimeLicensing: false, downloadableFiles: true }));
          setLoadMessage(`Loaded authoritative Store product ${savedDraft.projectName}. Review the completed-project context before copying.`);
        }
      } catch {
        if (!cancelled) setLoadMessage('The saved Store product or license policy could not be loaded. Manual SDK setup remains available.');
      } finally {
        if (!cancelled) setAuthoritativeLoading(false);
      }
    };
    void loadProduct();
    return () => { cancelled = true; };
  }, []);

  const parsedCapabilities = useMemo(() => editableCapabilities(capabilities), [capabilities]);
  const promptDraft = useMemo<LicensingPromptDraft>(() => ({
    ...draft,
    rails,
    featureFlags: capabilities.length > 0 && parsedCapabilities.success
      ? parsedCapabilities.data.map((capability) => capability.key).join(', ')
      : draft.featureFlags,
  }), [capabilities.length, draft, parsedCapabilities, rails]);
  useEffect(() => {
    if (!parsedCapabilities.success) {
      setPrompt('');
      setGeneratingBundle(false);
      return;
    }
    let cancelled = false;
    setGeneratingBundle(true);
    setPrompt('');
    setGenerationError('');
    const explicitCapabilities = capabilities.length > 0 ? parsedCapabilities.data : undefined;
    const generate = async () => {
      try {
        const generatedPrompt = await renderLicensingPrompt(
          buildLicensingPromptEnvelope(promptDraft),
          explicitCapabilities,
        );
        if (!cancelled) setPrompt(generatedPrompt);
      } catch {
        if (!cancelled) {
          setPrompt('');
          setGenerationError('The SDK files could not be generated. Review the capability model and try again.');
        }
      } finally {
        if (!cancelled) setGeneratingBundle(false);
      }
    };
    void generate();
    return () => { cancelled = true; };
  }, [capabilities.length, parsedCapabilities, promptDraft]);
  const sdkBundle = useMemo(() => prompt ? extractLicensingSdkBundle(prompt) : null, [prompt]);
  const selectedFileText = sdkBundle ? fileText(sdkBundle.files[selectedFile].content) : '';
  const requiredReady = draft.projectName.trim().length > 0
    && draft.projectContext.trim().length > 0
    && (draft.mode === 'dynamic' || draft.outputFormats.trim().length > 0)
    && parsedCapabilities.success
    && Boolean(sdkBundle)
    && !generatingBundle;
  const capabilityError = (index: number, field: string): string | undefined => {
    if (parsedCapabilities.success) return undefined;
    const directIssue = parsedCapabilities.error.issues.find((issue) => (
      issue.path[0] === index && issue.path[1] === field
    ));
    if (directIssue) return directIssue.message;
    if (field === 'key') {
      const key = capabilities[index]?.key.trim();
      if (key && capabilities.some((capability, capabilityIndex) => (
        capabilityIndex !== index && capability.key.trim() === key
      ))) return 'Capability keys must be unique.';
    }
    if (field === 'dependencyKeys') {
      const cycleIssue = parsedCapabilities.error.issues.find((issue) => issue.message.includes('dependency cycle'));
      if (cycleIssue) return cycleIssue.message;
    }
    return undefined;
  };

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
      const envelope = buildLicensingPromptEnvelope(promptDraft);
      window.sessionStorage.setItem(
        LICENSING_STORE_HANDOFF_KEY,
        serializeLicensingStoreHandoff(
          envelope,
          activeGuildId,
          undefined,
          crypto.randomUUID(),
          parsedCapabilities.success ? parsedCapabilities.data : [],
        ),
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
    setCapabilities([]);
    setRails(INITIAL_RAILS);
    setCopied(false);
    setCopyError('');
  };
  const updateCapability = <Key extends keyof EditableCapability>(
    index: number,
    key: Key,
    value: EditableCapability[Key],
  ) => {
    setCopied(false);
    setCopiedFile(null);
    setCapabilities((current) => current.map((capability, capabilityIndex) => (
      capabilityIndex === index ? { ...capability, [key]: value } : capability
    )));
  };
  const updateRail = (key: keyof LicensingRails, enabled: boolean) => {
    setCopied(false);
    setCopiedFile(null);
    setRails((current) => ({ ...current, [key]: enabled }));
  };
  const addCapability = () => {
    setCopied(false);
    setCopiedFile(null);
    setCapabilities((current) => [...current, { ...EMPTY_CAPABILITY }]);
  };
  const copySelectedFile = async () => {
    try {
      await navigator.clipboard.writeText(selectedFileText);
      setCopiedFile(selectedFile);
      setCopyError('');
    } catch {
      setCopiedFile(null);
      setCopyError('Clipboard access was blocked. Allow clipboard access for this dashboard and try again.');
    }
  };
  const removeCapability = (index: number) => {
    setCopied(false);
    setCopiedFile(null);
    setCapabilities((current) => {
      const next = current.filter((_, capabilityIndex) => capabilityIndex !== index);
      if (next.length === 0) setDraft((currentDraft) => ({ ...currentDraft, featureFlags: '' }));
      return next;
    });
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
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <fieldset disabled={authoritativeLoading} aria-labelledby="prompt-input-heading" aria-busy={authoritativeLoading} className="min-w-0 space-y-5 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 disabled:opacity-70 sm:p-5">
          <div role="group" aria-label="Integration rails" className="space-y-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Integration rails</p>
              <p className="mt-1 text-xs text-discord-text-muted">Choose every delivery and access rail independently. A mixed product can use any combination.</p>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {RAIL_OPTIONS.map((rail) => (
                <label key={rail.key} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-input border border-discord-border-subtle bg-discord-bg-tertiary p-3">
                  <input
                    type="checkbox"
                    aria-label={rail.label}
                    checked={rails[rail.key]}
                    onChange={(event) => updateRail(rail.key, event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-discord-accent"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-discord-text-primary">{rail.label}</span>
                    <span className="mt-1 block text-xs text-discord-text-muted">{rail.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

        <div className="mt-5">
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
        <div className="space-y-2 rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3">
          <p className="text-sm font-semibold text-discord-text-primary">Private integration context</p>
          <p className="text-xs text-discord-text-secondary">This private owner-authored context is included in copied and downloaded SDK files and in a temporary Store handoff. Do not include license keys, customer data, or provider secrets.</p>
          <TextAreaField id="licensing-project-context" label="Completed project context" value={draft.projectContext} onChange={(value) => update('projectContext', value)} placeholder="Describe the existing repository, behavior, language, runtime, packaging, deployment, licensed capabilities, and everything the licensing change must preserve." />
        </div>
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
        <section aria-labelledby="capabilities-heading" className="min-w-0 space-y-3 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="capabilities-heading" className="text-sm font-semibold text-discord-text-primary">Licensed capabilities</h3>
              <p className="mt-1 text-xs text-discord-text-muted">Define each grant by a stable machine key and the exact behavior it controls. Plans grant capabilities; plan names never imply them.</p>
            </div>
            <Button type="button" variant="secondary" onClick={addCapability}>
              <Plus size={16} aria-hidden="true" />Add capability
            </Button>
          </div>
          {capabilities.length === 0 && (
            <p className="rounded-input border border-dashed border-discord-border-strong p-3 text-xs text-discord-text-muted">No capability rows yet. Add one for every independently controlled feature.</p>
          )}
          {capabilities.map((capability, index) => {
            const number = index + 1;
            return (
              <article key={index} className="min-w-0 space-y-3 rounded-input border border-discord-border-subtle bg-discord-bg-secondary p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-discord-text-primary">Capability {number}</h4>
                  <Button type="button" variant="secondary" onClick={() => removeCapability(index)} aria-label={`Remove capability ${number}`}>
                    <Trash2 size={16} aria-hidden="true" />Remove
                  </Button>
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input id={`capability-key-${number}`} aria-label={`Capability key ${number}`} label="Capability key" value={capability.key} onChange={(event) => updateCapability(index, 'key', event.target.value)} placeholder="premium.exports" error={capabilityError(index, 'key')} />
                  <Input id={`capability-name-${number}`} aria-label={`Capability name ${number}`} label="Name" value={capability.name} onChange={(event) => updateCapability(index, 'name', event.target.value)} placeholder="Premium exports" error={capabilityError(index, 'name')} />
                </div>
                <TextAreaField id={`capability-meaning-${number}`} label={`Behavioral meaning ${number}`} value={capability.behavioralMeaning} onChange={(value) => updateCapability(index, 'behavioralMeaning', value)} placeholder="What customer ability this entitlement represents." error={capabilityError(index, 'behavioralMeaning')} />
                <TextAreaField id={`capability-functionality-${number}`} label={`Controlled functionality ${number}`} value={capability.controlledFunctionality} onChange={(value) => updateCapability(index, 'controlledFunctionality', value)} placeholder="The exact commands, routes, exports, or operations to gate." error={capabilityError(index, 'controlledFunctionality')} />
                <Input id={`capability-plans-${number}`} aria-label={`Granting plans ${number}`} label="Granting plans" value={capability.grantingPlansText} onChange={(event) => updateCapability(index, 'grantingPlansText', event.target.value)} placeholder="pro: Pro, studio: Studio" error={capabilityError(index, 'grantingPlans')} />
                <p className="-mt-2 text-xs text-discord-text-muted">Comma-separated stable plan key and display name pairs.</p>
                <TextAreaField id={`capability-unavailable-${number}`} label={`Unavailable behavior ${number}`} value={capability.unavailableBehavior} onChange={(value) => updateCapability(index, 'unavailableBehavior', value)} placeholder="What remains usable and what is refused when this capability is absent." error={capabilityError(index, 'unavailableBehavior')} />
                <Input id={`capability-dependencies-${number}`} aria-label={`Dependency keys ${number}`} label="Dependency keys" value={capability.dependencyKeysText} onChange={(event) => updateCapability(index, 'dependencyKeysText', event.target.value)} placeholder="core.editor, exports.base" error={capabilityError(index, 'dependencyKeys')} />
              </article>
            );
          })}
          {!parsedCapabilities.success && capabilities.length > 0 && (
            <p className="rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">Complete every capability field. Keys must be unique, stable lowercase identifiers; plan pairs use “key: Name”.</p>
          )}
        </section>

        <details className="rounded-input border border-discord-border-subtle bg-discord-bg-primary p-3">
          <summary className="cursor-pointer text-sm font-semibold text-discord-text-secondary">Legacy compatibility fields</summary>
          <div className="mt-3 space-y-3">
            <TextAreaField id="licensing-plans-features" label="Legacy plan notes" value={draft.plansAndFeatures} onChange={(value) => update('plansAndFeatures', value)} placeholder="Older saved products may prefill these notes. Structured capability rows are authoritative for new setup." />
            {draft.mode === 'dynamic' && <Input label="Legacy feature flags" value={draft.featureFlags} onChange={(event) => update('featureFlags', event.target.value)} placeholder="pro-mode, exports" />}
          </div>
        </details>

        {draft.mode === 'dynamic' ? (
          <div className="space-y-4 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4">
            <Input label="Installation identity" value={draft.installationIdentity} onChange={(event) => update('installationIdentity', event.target.value)} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="Max installations" type="number" min={1} max={100} value={draft.maxInstallations} onChange={(event) => update('maxInstallations', Math.max(1, Math.min(100, Number(event.target.value))))} />
              <Input label="Heartbeat seconds" type="number" min={60} max={86400} value={draft.heartbeatSeconds} onChange={(event) => update('heartbeatSeconds', Math.max(60, Math.min(86400, Number(event.target.value))))} />
              <Input label="Offline grace seconds" type="number" min={0} max={604800} value={draft.offlineGraceSeconds} onChange={(event) => update('offlineGraceSeconds', Math.max(0, Math.min(604800, Number(event.target.value))))} />
            </div>
          </div>
        ) : (
          <TextAreaField id="licensing-output-formats" label="Output formats" value={draft.outputFormats} onChange={(value) => update('outputFormats', value)} placeholder="List every delivered format, including future variants that need a verified buyer-derivative transformer." />
        )}
      </fieldset>

      <section aria-labelledby="generated-prompt-heading" className="min-w-0 self-start rounded-card border border-discord-accent/40 bg-discord-bg-secondary p-4 sm:p-5 xl:sticky xl:top-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="generated-prompt-heading" className="text-lg font-semibold text-discord-text-primary">Generated SDK integration contract</h2>
            <p className="mt-1 text-sm text-discord-text-secondary">Nothing is saved on the server. Inspect the four files before copying, downloading, or privately handing the contract to Store.</p>
          </div>
          <span className="rounded-full bg-discord-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-discord-accent">Stateless</span>
        </div>
        {!requiredReady && <p className="mt-4 rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3 text-xs text-discord-warning" role="status">Add a project name, a real project description, and every static output format before copying.</p>}
        {copyError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{copyError}</p>}
        {handoffError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{handoffError}</p>}
        {generationError && <p className="mt-4 rounded-input border border-discord-danger/40 bg-discord-danger/10 p-3 text-xs text-discord-danger" role="alert">{generationError}</p>}
        {generatingBundle && <p className="mt-4 text-xs text-discord-text-muted" role="status">Generating the four SDK files…</p>}
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-3">
          <div className="flex max-w-full flex-wrap gap-2" aria-label="SDK bundle files">
            {SDK_FILE_NAMES.map((fileName) => (
              <button
                key={fileName}
                type="button"
                aria-pressed={selectedFile === fileName}
                onClick={() => { setSelectedFile(fileName); setCopiedFile(null); }}
                className={`max-w-full break-all rounded-input border px-3 py-2 text-left text-xs font-semibold transition-standard ${modeButtonClass(selectedFile === fileName)}`}
              >
                {fileName}
              </button>
            ))}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Selected file: <span className="normal-case text-discord-text-primary">{selectedFile}</span></p>
            <pre className="mt-2 max-h-[52vh] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-input bg-discord-bg-floating p-3 text-xs leading-5 text-discord-text-secondary sm:p-4"><code>{selectedFileText}</code></pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => void copySelectedFile()} disabled={!requiredReady || authoritativeLoading}>
              <Copy size={16} aria-hidden="true" />{copiedFile === selectedFile ? 'Selected file copied' : 'Copy selected file'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => downloadText(selectedFile, selectedFileText)} disabled={!requiredReady || authoritativeLoading}>
              <Download size={16} aria-hidden="true" />Download selected file
            </Button>
            <Button type="button" variant="secondary" onClick={() => { if (sdkBundle) downloadText('somnibot-sdk-bundle.json', JSON.stringify(sdkBundle, null, 2), 'application/json;charset=utf-8'); }} disabled={!requiredReady || authoritativeLoading}>
              <Download size={16} aria-hidden="true" />Download SDK bundle
            </Button>
          </div>
          <details className="min-w-0 rounded-input border border-discord-border-subtle p-3">
            <summary className="cursor-pointer text-xs font-semibold text-discord-text-secondary">Inspect complete copy contract</summary>
            <pre className="mt-3 max-h-[45vh] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-input bg-discord-bg-floating p-3 text-xs leading-5 text-discord-text-secondary"><code>{prompt}</code></pre>
          </details>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy()} disabled={!requiredReady || authoritativeLoading}><Copy size={16} aria-hidden="true" />{copied ? 'SDK contract copied' : 'Copy SDK contract'}</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={useInStore}
            disabled={!requiredReady || authoritativeLoading || !activeGuildId || Boolean(draft.productId)}
            title={draft.productId ? 'This SDK contract already comes from an authoritative saved product' : undefined}
          >
            <ArrowRight size={16} aria-hidden="true" />Use in Store
          </Button>
          <Button type="button" variant="secondary" onClick={clear} disabled={authoritativeLoading}><RotateCcw size={16} aria-hidden="true" />Clear</Button>
        </div>
      </section>
    </div>
  );
}
