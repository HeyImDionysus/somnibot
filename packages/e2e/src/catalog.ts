import { z } from 'zod';

export const CATALOG_SCHEMA_VERSION = '1.0.0' as const;

export const CATEGORY_SPECS = Object.freeze([
  Object.freeze({ id: 'community', name: 'Community', domainCount: 10 }),
  Object.freeze({ id: 'game-economy', name: 'Game economy', domainCount: 14 }),
  Object.freeze({ id: 'moderation', name: 'Moderation', domainCount: 5 }),
  Object.freeze({ id: 'music', name: 'Music', domainCount: 2 }),
  Object.freeze({ id: 'commerce', name: 'Commerce', domainCount: 5 }),
  Object.freeze({ id: 'administration', name: 'Administration', domainCount: 8 }),
  Object.freeze({ id: 'infrastructure', name: 'Infrastructure', domainCount: 2 }),
] as const);

export const SCENARIO_CLASSES = Object.freeze([
  'DEF',
  'SET-A',
  'SET-B',
  'INVALID',
  'UNAUTH',
  'DEPFAIL',
  'RETRY',
  'REPLAY',
  'RESTART',
  'RACE',
  'XGUILD',
  'CLEANUP',
] as const);

export const ASSERTION_CLASSES = Object.freeze([
  'Discord',
  'database-RLS',
  'audit',
  'owner-notification',
  'branding',
  'replay-safety',
  'cleanup',
] as const);

export const REQUIRED_PLATFORMS = Object.freeze(['Windows', 'Linux'] as const);
export const EXCLUDED_PLATFORMS = Object.freeze(['macOS'] as const);
export const DOMAIN_COUNT = 46 as const;

export type CategoryId = (typeof CATEGORY_SPECS)[number]['id'];
export type ScenarioClass = (typeof SCENARIO_CLASSES)[number];
export type AssertionClass = (typeof ASSERTION_CLASSES)[number];
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const IdentifierSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    'Expected a lowercase kebab-case identifier',
  );

const RequiredTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine(
    (value) => !/^(?:\[|\(|<)?(?:todo|tbd|placeholder|mock-only|skip)(?:\]|\)|>)?(?::|$)/i.test(value),
    'Unresolved placeholder text is forbidden',
  );
const CatalogVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected a semantic version');

const CategoryIdSchema = z.enum(CATEGORY_SPECS.map((spec) => spec.id) as [CategoryId, ...CategoryId[]]);
const ScenarioClassSchema = z.enum(SCENARIO_CLASSES);
const AssertionClassSchema = z.enum(ASSERTION_CLASSES);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const ControlSchema = z
  .object({
    id: IdentifierSchema,
    description: RequiredTextSchema,
    valueType: z.enum([
      'boolean',
      'integer',
      'number',
      'string',
      'string-list',
      'duration-ms',
      'enum',
      'json',
    ]),
    constraints: z.record(JsonValueSchema),
  })
  .strict();

const DefaultSchema = z
  .object({
    controlId: IdentifierSchema,
    value: JsonValueSchema,
    rationale: RequiredTextSchema,
  })
  .strict();

const PermissionSchema = z
  .object({
    id: IdentifierSchema,
    actor: RequiredTextSchema,
    action: RequiredTextSchema,
    defaultDecision: z.enum(['allow', 'deny']),
    enforcement: RequiredTextSchema,
  })
  .strict();

const MessageSchema = z
  .object({
    id: IdentifierSchema,
    trigger: RequiredTextSchema,
    surface: RequiredTextSchema,
    audience: RequiredTextSchema,
    defaultTemplate: RequiredTextSchema,
    variables: z.array(IdentifierSchema),
  })
  .strict()
  .superRefine((message, ctx) => {
    addDuplicateIssues(message.variables, ctx, ['variables'], 'message variable');
    const placeholders = [...message.defaultTemplate.matchAll(/\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}/g)]
      .map((match) => match[1]);
    requireExactMembers(placeholders, message.variables, ctx, ['defaultTemplate'], 'message variable');
    requireExactMembers(message.variables, placeholders, ctx, ['variables'], 'template placeholder');
  });

const StateValueSchema = z
  .object({
    id: IdentifierSchema,
    description: RequiredTextSchema,
  })
  .strict();

const StateTransitionSchema = z
  .object({
    id: IdentifierSchema,
    from: IdentifierSchema,
    to: IdentifierSchema,
    trigger: RequiredTextSchema,
    expectedEffect: RequiredTextSchema,
  })
  .strict();

const StateSchema = z
  .object({
    initial: IdentifierSchema,
    values: z.array(StateValueSchema).min(1),
    transitions: z.array(StateTransitionSchema).min(1),
  })
  .strict();

const FailureSchema = z
  .object({
    id: IdentifierSchema,
    trigger: RequiredTextSchema,
    expectedBehavior: RequiredTextSchema,
    resultingState: IdentifierSchema,
    retry: z.enum(['never', 'automatic', 'operator']),
    messageId: IdentifierSchema,
    auditEvent: RequiredTextSchema,
    ownerNotification: z.boolean(),
  })
  .strict();

const EvidenceSchema = z
  .object({
    assertionClass: AssertionClassSchema,
    proofMode: z.literal('real-stack'),
    observer: RequiredTextSchema,
    expectedObservation: RequiredTextSchema,
    artifact: RequiredTextSchema,
  })
  .strict();

const ScenarioAssertionSchema = z
  .object({
    assertionClass: AssertionClassSchema,
    expectedObservation: RequiredTextSchema,
  })
  .strict();

const ScenarioSchema = z
  .object({
    id: IdentifierSchema,
    class: ScenarioClassSchema,
    disposition: z.literal('required'),
    promise: RequiredTextSchema,
    expectedOutcome: RequiredTextSchema,
    assertions: z.array(ScenarioAssertionSchema).length(ASSERTION_CLASSES.length),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const assertionClasses = scenario.assertions.map((assertion) => assertion.assertionClass);
    addDuplicateIssues(assertionClasses, ctx, ['assertions'], 'scenario assertion class');
    requireExactMembers(
      assertionClasses,
      ASSERTION_CLASSES,
      ctx,
      ['assertions'],
      'scenario assertion class',
    );
  });

const DomainContractBaseSchema = z
  .object({
    id: IdentifierSchema,
    name: RequiredTextSchema,
    category: CategoryIdSchema,
    promise: RequiredTextSchema,
    controls: z.array(ControlSchema).min(1),
    defaults: z.array(DefaultSchema).min(1),
    permissions: z.array(PermissionSchema).min(1),
    messages: z.array(MessageSchema).min(1),
    state: StateSchema,
    failures: z.array(FailureSchema).min(1),
    evidence: z.array(EvidenceSchema).length(ASSERTION_CLASSES.length),
    scenarios: z.array(ScenarioSchema).length(SCENARIO_CLASSES.length),
  })
  .strict();

const DomainContractSchema = DomainContractBaseSchema.superRefine((domain, ctx) => {
  addDuplicateIssues(
    domain.controls.map((control) => control.id),
    ctx,
    ['controls'],
    'control id',
  );
  addDuplicateIssues(
    domain.defaults.map((entry) => entry.controlId),
    ctx,
    ['defaults'],
    'default control id',
  );
  addDuplicateIssues(
    domain.permissions.map((permission) => permission.id),
    ctx,
    ['permissions'],
    'permission id',
  );
  addDuplicateIssues(
    domain.messages.map((message) => message.id),
    ctx,
    ['messages'],
    'message id',
  );
  addDuplicateIssues(
    domain.state.values.map((state) => state.id),
    ctx,
    ['state', 'values'],
    'state id',
  );
  addDuplicateIssues(
    domain.state.transitions.map((transition) => transition.id),
    ctx,
    ['state', 'transitions'],
    'transition id',
  );
  addDuplicateIssues(
    domain.failures.map((failure) => failure.id),
    ctx,
    ['failures'],
    'failure id',
  );
  addDuplicateIssues(
    domain.evidence.map((entry) => entry.assertionClass),
    ctx,
    ['evidence'],
    'evidence assertion class',
  );
  addDuplicateIssues(
    domain.scenarios.map((scenario) => scenario.id),
    ctx,
    ['scenarios'],
    'scenario id',
  );
  addDuplicateIssues(
    domain.scenarios.map((scenario) => scenario.class),
    ctx,
    ['scenarios'],
    'scenario class',
  );

  const controlIds = new Set(domain.controls.map((control) => control.id));
  const defaultControlIds = new Set(domain.defaults.map((entry) => entry.controlId));
  for (const [index, entry] of domain.defaults.entries()) {
    if (!controlIds.has(entry.controlId)) {
      addIssue(ctx, ['defaults', index, 'controlId'], `Unknown control "${entry.controlId}"`);
      continue;
    }
    const control = domain.controls.find((candidate) => candidate.id === entry.controlId)!;
    validateDefaultValue(control, entry.value, ctx, ['defaults', index, 'value']);
  }
  for (const [index, control] of domain.controls.entries()) {
    if (!defaultControlIds.has(control.id)) {
      addIssue(ctx, ['controls', index, 'id'], `Control "${control.id}" has no default`);
    }
  }

  const stateIds = new Set(domain.state.values.map((state) => state.id));
  if (!stateIds.has(domain.state.initial)) {
    addIssue(ctx, ['state', 'initial'], `Unknown initial state "${domain.state.initial}"`);
  }
  for (const [index, transition] of domain.state.transitions.entries()) {
    if (!stateIds.has(transition.from)) {
      addIssue(ctx, ['state', 'transitions', index, 'from'], `Unknown state "${transition.from}"`);
    }
    if (!stateIds.has(transition.to)) {
      addIssue(ctx, ['state', 'transitions', index, 'to'], `Unknown state "${transition.to}"`);
    }
  }

  const messageIds = new Set(domain.messages.map((message) => message.id));
  for (const [index, failure] of domain.failures.entries()) {
    if (!stateIds.has(failure.resultingState)) {
      addIssue(ctx, ['failures', index, 'resultingState'], `Unknown state "${failure.resultingState}"`);
    }
    if (!messageIds.has(failure.messageId)) {
      addIssue(ctx, ['failures', index, 'messageId'], `Unknown message "${failure.messageId}"`);
    }
  }

  requireExactMembers(
    domain.evidence.map((entry) => entry.assertionClass),
    ASSERTION_CLASSES,
    ctx,
    ['evidence'],
    'assertion class',
  );
  requireExactMembers(
    domain.scenarios.map((scenario) => scenario.class),
    SCENARIO_CLASSES,
    ctx,
    ['scenarios'],
    'scenario class',
  );

});

const PlatformScopeSchema = z
  .object({
    required: z.array(z.enum(REQUIRED_PLATFORMS)).length(REQUIRED_PLATFORMS.length),
    excluded: z.array(z.enum(EXCLUDED_PLATFORMS)).length(EXCLUDED_PLATFORMS.length),
  })
  .strict()
  .superRefine((platforms, ctx) => {
    requireExactMembers(
      platforms.required,
      REQUIRED_PLATFORMS,
      ctx,
      ['required'],
      'required platform',
    );
    requireExactMembers(
      platforms.excluded,
      EXCLUDED_PLATFORMS,
      ctx,
      ['excluded'],
      'excluded platform',
    );
  });

const WatchTogetherDefermentSchema = z
  .object({
    id: z.literal('watch-together'),
    name: z.literal('Watch Together'),
    disposition: z.literal('deferred'),
    targetRelease: z.literal('v1.1'),
  })
  .strict();

const CategorySchema = z
  .object({
    id: CategoryIdSchema,
    name: RequiredTextSchema,
    domains: z.array(DomainContractSchema),
  })
  .strict();

const DomainCatalogBaseSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    catalogVersion: CatalogVersionSchema,
    release: z.literal('v1.0'),
    scope: z
      .object({
        platforms: PlatformScopeSchema,
        deferments: z.array(WatchTogetherDefermentSchema).length(1),
      })
      .strict(),
    categories: z.array(CategorySchema).length(CATEGORY_SPECS.length),
  })
  .strict();

export const DomainCatalogSchema = DomainCatalogBaseSchema.superRefine((catalog, ctx) => {
  addDuplicateIssues(
    catalog.categories.map((category) => category.id),
    ctx,
    ['categories'],
    'category id',
  );

  const allDomainIds: string[] = [];
  const allScenarioIds: string[] = [];
  for (const spec of CATEGORY_SPECS) {
    const categoryIndex = catalog.categories.findIndex((category) => category.id === spec.id);
    if (categoryIndex === -1) {
      addIssue(ctx, ['categories'], `Missing category "${spec.id}"`);
      continue;
    }

    const category = catalog.categories[categoryIndex];
    if (category.name !== spec.name) {
      addIssue(
        ctx,
        ['categories', categoryIndex, 'name'],
        `Category "${spec.id}" must be named "${spec.name}"`,
      );
    }
    if (category.domains.length !== spec.domainCount) {
      addIssue(
        ctx,
        ['categories', categoryIndex, 'domains'],
        `Category "${spec.id}" requires exactly ${spec.domainCount} domains`,
      );
    }

    for (const [domainIndex, domain] of category.domains.entries()) {
      allDomainIds.push(domain.id);
      allScenarioIds.push(...domain.scenarios.map((scenario) => scenario.id));
      if (domain.category !== category.id) {
        addIssue(
          ctx,
          ['categories', categoryIndex, 'domains', domainIndex, 'category'],
          `Domain category "${domain.category}" does not match container "${category.id}"`,
        );
      }
    }
  }

  if (allDomainIds.length !== DOMAIN_COUNT) {
    addIssue(ctx, ['categories'], `Catalog requires exactly ${DOMAIN_COUNT} domains`);
  }
  addDuplicateIssues(allDomainIds, ctx, ['categories'], 'domain id');
  addDuplicateIssues(allScenarioIds, ctx, ['categories'], 'scenario id');
});

export type DomainContract = z.infer<typeof DomainContractSchema>;
export type DomainCatalog = z.infer<typeof DomainCatalogSchema>;

function addIssue(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function addDuplicateIssues(
  values: readonly string[],
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    if (seen.has(value) && !reported.has(value)) {
      addIssue(ctx, path, `Duplicate ${label} "${value}"`);
      reported.add(value);
    }
    seen.add(value);
  }
}

function requireExactMembers<const T extends string>(
  actual: readonly T[],
  required: readonly T[],
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
): void {
  const actualSet = new Set(actual);
  for (const value of required) {
    if (!actualSet.has(value)) {
      addIssue(ctx, path, `Missing ${label} "${value}"`);
    }
  }
}

function validateDefaultValue(
  control: z.infer<typeof ControlSchema>,
  value: JsonValue,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  let valid = true;
  switch (control.valueType) {
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'integer':
      valid = typeof value === 'number' && Number.isInteger(value);
      break;
    case 'number':
      valid = typeof value === 'number';
      break;
    case 'string':
      valid = typeof value === 'string';
      break;
    case 'string-list':
      valid = Array.isArray(value) && value.every((entry) => typeof entry === 'string');
      break;
    case 'duration-ms':
      valid = typeof value === 'number' && Number.isInteger(value) && value >= 0;
      break;
    case 'enum': {
      const choices = control.constraints.values;
      valid =
        typeof value === 'string' &&
        Array.isArray(choices) &&
        choices.length > 0 &&
        choices.every((entry) => typeof entry === 'string') &&
        new Set(choices).size === choices.length &&
        choices.includes(value);
      break;
    }
    case 'json':
      valid = true;
      break;
  }

  if (!valid) {
    addIssue(ctx, path, `Default does not satisfy control type "${control.valueType}"`);
  }
}
