import { FEATURE_MANIFESTS, ROUTE_PERMISSIONS, type DashboardPermission } from '@somnibot/shared';
import { z } from 'zod';

export type AttentionView = 'owner' | 'administrator' | 'moderator' | 'finance' | 'support';

export interface ControlCenterDestination {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly domain: string;
  readonly keywords: readonly string[];
  readonly permission: DashboardPermission | null;
}

export interface AttentionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly permission: DashboardPermission | null;
  readonly priority: 'critical' | 'high' | 'normal';
}

export const DYNAMIC_SEARCH_KINDS = ['products', 'customers', 'members', 'incidents', 'audits'] as const;
export const DynamicSearchKindSchema = z.enum(DYNAMIC_SEARCH_KINDS);
export type DynamicSearchKind = z.infer<typeof DynamicSearchKindSchema>;

export const CONTROL_CENTER_SEARCH_KINDS = [
  'features', 'settings', 'commands', 'documentation', 'recovery', ...DYNAMIC_SEARCH_KINDS,
] as const;
export const ControlCenterSearchKindSchema = z.enum(CONTROL_CENTER_SEARCH_KINDS);
export type ControlCenterSearchKind = z.infer<typeof ControlCenterSearchKindSchema>;

export const ControlCenterSearchResultSchema = z.object({
  kind: ControlCenterSearchKindSchema,
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(500),
  href: z.string().regex(/^\/(?!\/)/),
});
export type ControlCenterSearchResult = z.infer<typeof ControlCenterSearchResultSchema>;

const DESTINATIONS: readonly ControlCenterDestination[] = [
  { id: 'dashboard', label: 'Dashboard', description: 'Current attention, activity, readiness, and deployment context', href: '/dashboard', domain: 'Operations', keywords: ['home', 'attention', 'status'], permission: null },
  { id: 'diagnostics', label: 'Diagnostics', description: 'Bot, provider, queue, and runtime health', href: '/diagnostics', domain: 'Operations', keywords: ['health', 'deployment', 'recovery'], permission: 'dashboard.view_diagnostics' },
  { id: 'incidents', label: 'Incidents', description: 'Active incidents, impact, mitigation, and recovery evidence', href: '/incidents', domain: 'Operations', keywords: ['outage', 'degraded', 'recovery'], permission: 'dashboard.manage_incidents' },
  { id: 'workflows', label: 'Workflows', description: 'Failed or delayed background work and supported retries', href: '/workflows', domain: 'Operations', keywords: ['queue', 'retry', 'dead letter'], permission: 'dashboard.view_workflows' },
  { id: 'audit', label: 'Audit log', description: 'Actor-attributed changes and runtime effects', href: '/audit', domain: 'Operations', keywords: ['history', 'changes', 'evidence'], permission: 'dashboard.view_audit' },
  { id: 'roles', label: 'Roles', description: 'Role hierarchy, templates, and permission safety', href: '/roles', domain: 'Server', keywords: ['tier', 'permission', 'discord'], permission: 'dashboard.manage_roles' },
  { id: 'channels', label: 'Channels', description: 'Server channel structure and templates', href: '/channels', domain: 'Server', keywords: ['category', 'discord', 'structure'], permission: 'dashboard.manage_channels' },
  { id: 'onboarding', label: 'Onboarding', description: 'Discord onboarding and member entry paths', href: '/onboarding', domain: 'Community', keywords: ['welcome', 'member', 'setup'], permission: 'dashboard.manage_server' },
  { id: 'moderation', label: 'Moderation', description: 'AutoMod policy and moderation configuration', href: '/moderation', domain: 'Moderation', keywords: ['automod', 'rules', 'safety'], permission: 'dashboard.manage_moderation' },
  { id: 'appeals', label: 'Appeals', description: 'Moderation appeals, decisions, and notifications', href: '/moderation/appeals', domain: 'Moderation', keywords: ['ban', 'infraction', 'review'], permission: 'dashboard.manage_moderation' },
  { id: 'tickets', label: 'Tickets', description: 'Support panels, open tickets, and transcripts', href: '/tickets', domain: 'Support', keywords: ['panel', 'transcript', 'help'], permission: 'dashboard.manage_tickets' },
  { id: 'automations', label: 'Automations', description: 'Triggers, conditions, actions, and recursion safety', href: '/automations', domain: 'Automation', keywords: ['event', 'action', 'workflow'], permission: 'dashboard.manage_automations' },
  { id: 'economy', label: 'Coin economy', description: 'Virtual currency, progression, games, and rewards', href: '/economy', domain: 'Community', keywords: ['coins', 'crafting', 'farming'], permission: 'dashboard.manage_economy' },
  { id: 'music', label: 'Music', description: 'Voice playback, queue, and player configuration', href: '/music', domain: 'Community', keywords: ['voice', 'queue', 'lavalink'], permission: 'dashboard.manage_server' },
  { id: 'store', label: 'Real-money store', description: 'Products, launch readiness, and fulfillment', href: '/store', domain: 'Commerce', keywords: ['product', 'paypal', 'launch'], permission: 'dashboard.manage_store' },
  { id: 'orders', label: 'Orders', description: 'Payments, fulfillment, refunds, and reconciliation', href: '/store/orders', domain: 'Commerce', keywords: ['payment', 'refund', 'paypal'], permission: 'dashboard.manage_orders' },
  { id: 'customers', label: 'Customers', description: 'Customer identities, entitlements, and support context', href: '/customers', domain: 'Commerce', keywords: ['buyer', 'entitlement', 'identity'], permission: 'dashboard.manage_customers' },
  { id: 'licenses', label: 'Licenses', description: 'License keys, installations, and revocation', href: '/licenses', domain: 'Commerce', keywords: ['sdk', 'installation', 'entitlement'], permission: 'dashboard.manage_licenses' },
  { id: 'fraud', label: 'Fraud and disputes', description: 'Fraud signals, disputes, and resolution policy', href: '/fraud', domain: 'Commerce', keywords: ['chargeback', 'hold', 'risk'], permission: 'dashboard.view_fraud' },
  { id: 'team', label: 'Dashboard team', description: 'Staff access, roles, and invitations', href: '/settings/team', domain: 'Administration', keywords: ['staff', 'rbac', 'permission'], permission: 'dashboard.manage_team' },
  { id: 'settings', label: 'Settings', description: 'Guild-wide feature and operational configuration', href: '/settings', domain: 'Administration', keywords: ['configuration', 'features', 'bot'], permission: null },
  { id: 'sdk', label: 'SomniBot SDK', description: 'Agent-native project licensing integration contracts', href: '/sdk', domain: 'Commerce', keywords: ['licensing', 'agent', 'project'], permission: 'dashboard.manage_products' },
];

const ATTENTION: Record<AttentionView, readonly AttentionDefinition[]> = {
  owner: [
    { id: 'owner-runtime', label: 'Operational state', description: 'Confirm the deployed bot, providers, queues, backups, and recovery evidence.', href: '/diagnostics', permission: 'dashboard.view_diagnostics', priority: 'critical' },
    { id: 'owner-commerce', label: 'Commerce exceptions', description: 'Review failed or disputed customer and fulfillment work.', href: '/store/orders', permission: 'dashboard.manage_orders', priority: 'high' },
    { id: 'owner-staff', label: 'Staff access', description: 'Review team invitations and role assignments.', href: '/settings/team', permission: 'dashboard.manage_team', priority: 'normal' },
  ],
  administrator: [
    { id: 'admin-runtime', label: 'Runtime and queues', description: 'Resolve degraded providers and delayed background work.', href: '/diagnostics', permission: 'dashboard.view_diagnostics', priority: 'critical' },
    { id: 'admin-changes', label: 'Recent configuration changes', description: 'Review consequential changes and recovery options.', href: '/admin-changes', permission: 'dashboard.undo_changes', priority: 'normal' },
  ],
  moderator: [
    { id: 'mod-appeals', label: 'Appeals awaiting staff', description: 'Review pending appeals and their audit trail.', href: '/moderation/appeals', permission: 'dashboard.manage_moderation', priority: 'high' },
    { id: 'mod-tickets', label: 'Open support tickets', description: 'Respond to member reports and preserve transcripts.', href: '/tickets', permission: 'dashboard.manage_tickets', priority: 'normal' },
  ],
  finance: [
    { id: 'finance-orders', label: 'Payment and fulfillment exceptions', description: 'Resolve pending review, refunds, and reconciliation differences.', href: '/store/orders', permission: 'dashboard.manage_orders', priority: 'critical' },
    { id: 'finance-fraud', label: 'Fraud and disputes', description: 'Review holds, disputes, and chargebacks.', href: '/fraud', permission: 'dashboard.view_fraud', priority: 'high' },
  ],
  support: [
    { id: 'support-tickets', label: 'Customer requests', description: 'Handle open support work and failed delivery reports.', href: '/tickets', permission: 'dashboard.manage_tickets', priority: 'high' },
    { id: 'support-access', label: 'Customer access', description: 'Inspect entitlements, licenses, and identity relinking.', href: '/customers', permission: 'dashboard.manage_customers', priority: 'normal' },
  ],
};

function hasPermission(permissions: readonly DashboardPermission[], required: DashboardPermission | null): boolean {
  return required === null || permissions.includes('dashboard.full_access') || permissions.includes(required);
}

export function availableAttentionViews(permissions: readonly DashboardPermission[]): readonly AttentionView[] {
  if (permissions.includes('dashboard.full_access')) return ['owner', 'administrator', 'moderator', 'finance', 'support'];
  const views: AttentionView[] = [];
  if (permissions.includes('dashboard.manage_server') || permissions.includes('dashboard.manage_workflows')) views.push('administrator');
  if (permissions.includes('dashboard.manage_moderation')) views.push('moderator');
  if (permissions.includes('dashboard.manage_orders') || permissions.includes('dashboard.manage_store')) views.push('finance');
  if (permissions.includes('dashboard.manage_tickets') || permissions.includes('dashboard.manage_customers')) views.push('support');
  return views.length > 0 ? views : ['support'];
}

export function authorizedDestinations(permissions: readonly DashboardPermission[]): readonly ControlCenterDestination[] {
  return DESTINATIONS.filter((destination) => hasPermission(permissions, destination.permission));
}

export function attentionForView(view: AttentionView, permissions: readonly DashboardPermission[]): readonly AttentionDefinition[] {
  return ATTENTION[view].filter((item) => hasPermission(permissions, item.permission));
}

export function searchDestinations(destinations: readonly ControlCenterDestination[], query: string): readonly ControlCenterDestination[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === '') return [];
  return destinations.filter((destination) => [destination.label, destination.description, destination.domain, ...destination.keywords]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}

const DYNAMIC_KIND_PERMISSION: Readonly<Record<DynamicSearchKind, DashboardPermission>> = {
  products: 'dashboard.manage_products',
  customers: 'dashboard.manage_customers',
  members: 'dashboard.manage_server',
  incidents: 'dashboard.manage_incidents',
  audits: 'dashboard.view_audit',
};

function matchesQuery(values: readonly string[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized !== '' && values.some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function authorizedDynamicSearchKinds(permissions: readonly DashboardPermission[]): readonly DynamicSearchKind[] {
  return DYNAMIC_SEARCH_KINDS.filter((kind) => hasPermission(permissions, DYNAMIC_KIND_PERMISSION[kind]));
}

export function parseDynamicSearchResults(
  rows: unknown,
  allowedKinds: readonly DynamicSearchKind[],
): readonly ControlCenterSearchResult[] {
  if (!Array.isArray(rows)) return [];
  const allowed = new Set<DynamicSearchKind>(allowedKinds);
  const results: ControlCenterSearchResult[] = [];
  for (const row of rows) {
    const parsed = ControlCenterSearchResultSchema.safeParse(row);
    if (!parsed.success) continue;
    const kind = DynamicSearchKindSchema.safeParse(parsed.data.kind);
    if (kind.success && allowed.has(kind.data)) results.push(parsed.data);
  }
  return results;
}

export function searchStaticControlCenter(
  permissions: readonly DashboardPermission[],
  query: string,
): readonly ControlCenterSearchResult[] {
  const destinations = authorizedDestinations(permissions);
  const routeResults: ControlCenterSearchResult[] = searchDestinations(destinations, query).map((destination) => ({
    kind: destination.id === 'settings' || destination.id === 'team' ? 'settings' : 'features',
    id: `route:${destination.id}`,
    label: destination.label,
    description: destination.description,
    href: destination.href,
  }));
  const authorizedDestinationRoutes = destinations.map((destination) => destination.href);
  const routeIsAuthorized = (route: string): boolean => {
    if (permissions.includes('dashboard.full_access')) return true;
    const permissionEntry = Object.entries(ROUTE_PERMISSIONS)
      .filter(([prefix]) => route === prefix || route.startsWith(`${prefix}/`))
      .sort(([left], [right]) => right.length - left.length)[0];
    if (permissionEntry) return hasPermission(permissions, permissionEntry[1]);
    return authorizedDestinationRoutes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
  };
  const manifestResults: ControlCenterSearchResult[] = [];
  const commandResults: ControlCenterSearchResult[] = [];
  for (const manifest of FEATURE_MANIFESTS) {
    const route = manifest.surfaces.dashboardRoutes.find(routeIsAuthorized);
    if (!route) continue;
    if (matchesQuery([manifest.identity.name, manifest.identity.summary, manifest.identity.domain], query)) {
      manifestResults.push({
        kind: 'features',
        id: `feature:${manifest.identity.id}`,
        label: manifest.identity.name,
        description: manifest.identity.summary,
        href: route,
      });
    }
    for (const command of manifest.surfaces.discordCommands) {
      if (!matchesQuery([command, manifest.identity.name, manifest.identity.summary], query)) continue;
      commandResults.push({
        kind: 'commands',
        id: `command:${manifest.identity.id}:${command}`,
        label: command,
        description: `${manifest.identity.name} Discord command`,
        href: route,
      });
    }
  }
  const supplemental: readonly ControlCenterSearchResult[] = [
    { kind: 'documentation', id: 'docs:recovery', label: 'Recovery guidance', description: 'Diagnose degraded services and use supported recovery actions.', href: '/diagnostics' },
    { kind: 'recovery', id: 'recovery:diagnostics', label: 'System recovery', description: 'Open health, backup, incident, and recovery evidence.', href: '/diagnostics' },
  ];
  return [...routeResults, ...manifestResults, ...commandResults, ...supplemental.filter((result) => matchesQuery([result.label, result.description], query))];
}
