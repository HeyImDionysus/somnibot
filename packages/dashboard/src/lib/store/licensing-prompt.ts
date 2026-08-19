import { z } from 'zod';

const CONFIG_START = '<SOMNIBOT_PROJECT_LICENSING_CONFIG>';
const CONFIG_END = '</SOMNIBOT_PROJECT_LICENSING_CONFIG>';

export type LicensingPromptMode = 'dynamic' | 'static';
export type LicensingBillingModel = 'one_time' | 'subscription' | 'multiple' | 'free' | 'undecided';

type ProjectSurfaceGroup = {
  readonly id: string;
  readonly examples: string;
};

export const PROJECT_SURFACE_COVERAGE = {
  dynamic: [
    {
      id: 'native-applications',
      examples: 'Windows, macOS, and Linux executables; desktop apps; CLI tools; daemons; local services; Electron, Tauri, .NET, Java, Python, Node, Go, C, C++, and Rust applications',
    },
    {
      id: 'games-mods-and-plugins',
      examples: 'games; game-engine projects; multiplayer clients; dedicated-server software; Rust and Oxide plugins; mods; add-ons; editor plugins; and downloadable tools',
    },
    {
      id: 'browser-and-hosted-software',
      examples: 'web applications; PWAs; SPAs; SSR applications; APIs; SaaS products; hosted services; cloud workers; multiplayer services; and server-rendered tools',
    },
    {
      id: 'libraries-source-and-extensions',
      examples: 'libraries; SDKs; source-code products; packages for npm, PyPI, Cargo, NuGet, Maven, or other ecosystems; IDE extensions; and browser extensions',
    },
    {
      id: 'automation-data-and-embedded-systems',
      examples: 'Discord bots; AI agents; automation scripts; database tools; ETL and data pipelines; mobile apps; firmware; embedded software; IoT deployments; and scheduled jobs',
    },
  ],
  static: [
    {
      id: 'documents-and-publications',
      examples: 'PDFs; ebooks; text documents; spreadsheets; slide decks; reports; printable files; worksheets; and publications',
    },
    {
      id: 'images-design-and-fonts',
      examples: 'photographs; raster images; vector art; SVGs; layered design files; icons; illustrations; fonts; brushes; palettes; and design templates',
    },
    {
      id: 'audio-video-and-timelines',
      examples: 'music; sound effects; audio samples; presets; videos; animations; motion projects; LUTs; subtitles; and timeline-based media',
    },
    {
      id: 'models-cad-and-game-assets',
      examples: '3D models; CAD and CAM files; STL and STEP files; textures; materials; meshes; maps; sprites; game assets; scenes; and fabrication files',
    },
    {
      id: 'source-templates-archives-and-data',
      examples: 'HTML and CSS templates; source archives; prompts; notebooks; presets; configuration packs; datasets; model weights; project files; ZIP archives; and future downloadable formats',
    },
  ],
} satisfies Record<LicensingPromptMode, readonly ProjectSurfaceGroup[]>;

export type LicensingPromptDraft = {
  readonly mode: LicensingPromptMode;
  readonly projectName: string;
  readonly projectContext: string;
  readonly productId: string;
  readonly apiBase: string;
  readonly billingModel: LicensingBillingModel;
  readonly plansAndFeatures: string;
  readonly featureFlags: string;
  readonly outputFormats: string;
  readonly installationIdentity: string;
  readonly maxInstallations: number;
  readonly heartbeatSeconds: number;
  readonly offlineGraceSeconds: number;
};

const baseEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    context: z.string().min(1),
    productId: z.string().min(1).nullable(),
    apiBase: z.string().min(1),
  }),
  billing: z.object({
    model: z.enum(['one_time', 'subscription', 'multiple', 'free', 'undecided']),
    plansAndFeatures: z.string(),
  }),
});

const dynamicEnvelopeSchema = baseEnvelopeSchema.extend({
  mode: z.literal('dynamic'),
  dynamicPolicy: z.object({
    installationIdentity: z.string().min(1),
    maxInstallations: z.number().int().min(1).max(100),
    heartbeatSeconds: z.number().int().min(0).max(86_400),
    offlineGraceSeconds: z.number().int().min(0).max(604_800),
    featureFlags: z.array(z.string().min(1)).default([]),
  }),
  staticPolicy: z.null(),
});

const staticEnvelopeSchema = baseEnvelopeSchema.extend({
  mode: z.literal('static'),
  dynamicPolicy: z.null(),
  staticPolicy: z.object({ outputFormats: z.string().min(1) }),
});

export const licensingPromptEnvelopeSchema = z.discriminatedUnion('mode', [
  dynamicEnvelopeSchema,
  staticEnvelopeSchema,
]);

export type LicensingPromptEnvelope = z.infer<typeof licensingPromptEnvelopeSchema>;

export class LicensingPromptParseError extends Error {
  readonly code = 'LICENSING_PROMPT_PARSE_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'LicensingPromptParseError';
  }
}

function trimmed(value: string, fallback: string): string {
  const result = value.trim();
  return result.length > 0 ? result : fallback;
}

export function normalizeFeatureFlags(value: string | readonly string[]): string[] {
  const values = typeof value === 'string' ? value.split(',') : value;
  return [...new Set(values.map((flag) => flag.trim()).filter(Boolean))];
}

export function buildLicensingPromptEnvelope(draft: LicensingPromptDraft): LicensingPromptEnvelope {
  const base = {
    schemaVersion: 1,
    project: {
      name: trimmed(draft.projectName, 'Unnamed project'),
      context: trimmed(draft.projectContext, 'Inspect the surrounding project specification and implementation.'),
      productId: draft.productId.trim() || null,
      apiBase: trimmed(draft.apiBase, 'CONFIGURE_SOMNIBOT_API_BASE'),
    },
    billing: {
      model: draft.billingModel,
      plansAndFeatures: draft.plansAndFeatures.trim(),
    },
  };

  switch (draft.mode) {
    case 'dynamic':
      return dynamicEnvelopeSchema.parse({
        ...base,
        mode: 'dynamic',
        dynamicPolicy: {
          installationIdentity: trimmed(draft.installationIdentity, 'Define one stable installation, deployment, tenant, or device identity for this project.'),
          maxInstallations: draft.maxInstallations,
          heartbeatSeconds: draft.heartbeatSeconds,
          offlineGraceSeconds: draft.offlineGraceSeconds,
          featureFlags: normalizeFeatureFlags(draft.featureFlags),
        },
        staticPolicy: null,
      });
    case 'static':
      return staticEnvelopeSchema.parse({
        ...base,
        mode: 'static',
        dynamicPolicy: null,
        staticPolicy: {
          outputFormats: trimmed(draft.outputFormats, 'Inspect and enumerate every generated or packaged output format.'),
        },
      });
  }
}

function coverageLines(mode: LicensingPromptMode): string {
  return PROJECT_SURFACE_COVERAGE[mode]
    .map(({ id, examples }) => `- ${id}: ${examples}`)
    .join('\n');
}

function dynamicInstructions(): string {
  return `DYNAMIC IMPLEMENTATION CONTRACT
Use SomniBot's TypeScript SDK only when it naturally fits the existing stack. Otherwise implement the same validate, heartbeat, and deactivate REST contract in the project's actual language and runtime. Never convert the project or add a second runtime merely for licensing.

Keep PayPal checkout, Discord OAuth customer identity, entitlement issuance, and raw provider secrets outside the distributed project. Accept only the customer key or a short-lived authenticated application session. Bind it to the configured installation identity, enforce the configured active-installation limit, validate before paid features start, follow the server-directed heartbeat, respect the configured offline grace period, and never cache an active validation longer than the authoritative sdk_cache_ttl_ms returned by SomniBot.

Treat timeouts, network failures, rate limits, and 5xx responses as retryable or offline-grace outcomes. Treat refunded, revoked, expired, suspended, cancelled, over-device-limit, or invalidated-session verdicts as terminal. Disable only licensed capabilities without corrupting customer data. Deactivate the exact session on explicit sign-out or removal and only on shutdown paths the runtime can guarantee.

Never infer capabilities from a plan name or billing cadence. Enable only explicit entitlement features. Keep valuable operations, private content, signed updates, hosted services, multiplayer access, or cloud features server-authorized where the architecture permits. Obfuscation and anti-tamper measures may add friction but never replace server authority.`;
}

function staticInstructions(): string {
  return `STATIC IMPLEMENTATION CONTRACT
Produce a deterministic, customer-neutral master artifact. Do not add a runtime SDK, heartbeat, embedded payment client, Discord OAuth flow, raw customer identity, or license secret to static content.

SomniBot must verify the entitlement before issuing an expiring, single-use download. At delivery, create a buyer-specific derivative using a server-held HMAC seed, redundant format-aware marks, harmless structural variation, and a signed manifest containing the master hash, derivative hash, product ID when available, non-secret entitlement reference, algorithm version, and verification hints.

Use visible, low-salience, structural, metadata, spatial, temporal, or acoustic signals appropriate to every actual output. Assume metadata will be stripped and one obvious mark will be cropped or inpainted. Spread independent signals through pages, regions, frames, tracks, objects, files, archive members, or data structures. If no verified transformer exists for an output, fail closed and add an attack-tested transformer before enabling delivery. Never silently send the unprotected master.

Be truthful about revocation. It blocks future downloads, updates, replacement links, support, and connected services, but cannot erase a file already downloaded. Watermark evidence supports attribution and investigation; it is not remote deletion or a claim that copying is impossible.`;
}

export function renderLicensingPrompt(envelope: LicensingPromptEnvelope): string {
  const modeInstructions = envelope.mode === 'dynamic'
    ? dynamicInstructions()
    : staticInstructions();
  return `SOMNIBOT UNIVERSAL PROJECT LICENSING PROMPT

This prompt is a stateless implementation contract generated from owner-entered values. It does not create, change, or save a SomniBot product. The Store remains the commerce authority and the Licensing page remains the operational readback.

${CONFIG_START}
${JSON.stringify(envelope, null, 2)}
${CONFIG_END}

IMPLEMENTATION RULES
Inspect the already-completed project and its existing repository before choosing an integration. Preserve its behavior, language, runtime, architecture, packaging, deployment, configuration, error model, and test conventions. Limit changes to the SomniBot licensing integration and the smallest required configuration/documentation seams. The free-form project description is authoritative; the coverage groups below are adaptation examples, never a project-type menu.

When project.productId is null, require a deployment-time SOMNIBOT_PRODUCT_ID (or the surrounding project's equivalent configuration) and document that the owner copies the authoritative ID from the saved Store product. Never invent, guess, or hard-code a product ID. When a saved product ID is present, treat the saved Store product and license policy as authoritative over earlier planning values.

Supported ${envelope.mode} surfaces include:
${coverageLines(envelope.mode)}

SomniBot's database entitlement is the purchase authority. PayPal proves payment and Discord OAuth links the customer. Keep checkout, customer identity, and entitlement issuance in SomniBot rather than reimplementing them inside the project.

${modeInstructions}

ACCEPTANCE CONTRACT
For paid products, prove the normal PayPal Sandbox purchase and signed webhook flow. For free products, prove the supported free-claim path without PayPal. In both cases prove Discord-linked entitlement, configured billing and explicit feature grants, refund or cancellation where applicable, and manual revocation. Exercise the real built artifact or real generated derivative against SomniBot, not only mocks. Record non-secret evidence for every lifecycle verdict and verify that no raw key, provider secret, customer identifier, or signing secret appears in source, logs, browser bundles, archives, or delivered files.`;
}

export function extractLicensingPromptEnvelope(prompt: string): LicensingPromptEnvelope {
  const start = prompt.indexOf(CONFIG_START);
  const end = prompt.indexOf(CONFIG_END);
  if (start < 0 || end <= start) {
    throw new LicensingPromptParseError('The prompt does not contain a complete SomniBot configuration envelope.');
  }
  const json = prompt.slice(start + CONFIG_START.length, end).trim();
  try {
    return licensingPromptEnvelopeSchema.parse(JSON.parse(json));
  } catch (caught) {
    if (caught instanceof SyntaxError || caught instanceof z.ZodError) {
      throw new LicensingPromptParseError('The SomniBot configuration envelope is invalid.');
    }
    throw caught;
  }
}
