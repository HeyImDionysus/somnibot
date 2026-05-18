/**
 * Dashboard RBAC — Role definitions, permissions, and route access mapping.
 * Phase D: Fine-grained access control for the admin hub.
 */

import type { DashboardPermission } from '../types/database';

// ============================================================
// System Role Definitions
// ============================================================

export interface SystemRoleDefinition {
  name: string;
  description: string;
  permissions: DashboardPermission[];
  priority: number;
}

/**
 * Default system roles created on first setup.
 * Owner is always the guild owner and cannot be removed.
 */
export const SYSTEM_ROLES: Record<string, SystemRoleDefinition> = {
  owner: {
    name: 'owner',
    description: 'Full access to everything. Cannot be removed or reassigned.',
    permissions: ['dashboard.full_access'],
    priority: 100,
  },
  admin: {
    name: 'admin',
    description: 'Full access except team management and critical system settings.',
    permissions: [
      'dashboard.view_analytics',
      'dashboard.manage_store',
      'dashboard.manage_products',
      'dashboard.manage_orders',
      'dashboard.manage_customers',
      'dashboard.manage_licenses',
      'dashboard.manage_moderation',
      'dashboard.manage_tickets',
      'dashboard.manage_automations',
      'dashboard.manage_server',
      'dashboard.manage_roles',
      'dashboard.manage_channels',
      'dashboard.view_audit',
      'dashboard.view_diagnostics',
      'dashboard.manage_incidents',
      'dashboard.view_fraud',
      'dashboard.manage_fraud',
      'dashboard.view_workflows',
      'dashboard.manage_workflows',
      'dashboard.undo_changes',
    ],
    priority: 80,
  },
  moderator: {
    name: 'moderator',
    description: 'Manage moderation, tickets, and view member data.',
    permissions: [
      'dashboard.manage_moderation',
      'dashboard.manage_tickets',
      'dashboard.view_audit',
      'dashboard.view_diagnostics',
      'dashboard.manage_incidents',
    ],
    priority: 40,
  },
  support: {
    name: 'support',
    description: 'View customers, manage tickets, handle support operations.',
    permissions: [
      'dashboard.manage_tickets',
      'dashboard.manage_customers',
      'dashboard.manage_licenses',
      'dashboard.view_audit',
      'dashboard.view_fraud',
    ],
    priority: 30,
  },
  finance: {
    name: 'finance',
    description: 'Manage store, orders, promotions, and view analytics.',
    permissions: [
      'dashboard.view_analytics',
      'dashboard.manage_store',
      'dashboard.manage_products',
      'dashboard.manage_orders',
      'dashboard.manage_customers',
      'dashboard.view_audit',
      'dashboard.view_fraud',
    ],
    priority: 30,
  },
} as const;

// ============================================================
// Route → Permission Mapping
// ============================================================

/**
 * Maps dashboard routes to required permissions.
 * `null` means any authenticated user can access.
 * `dashboard.full_access` always grants access to everything.
 */
export const ROUTE_PERMISSIONS: Record<string, DashboardPermission | null> = {
  '/dashboard': null,
  '/roles': 'dashboard.manage_roles',
  '/channels': 'dashboard.manage_channels',
  '/onboarding': 'dashboard.manage_server',
  '/welcome': 'dashboard.manage_server',
  '/sync': 'dashboard.manage_server',
  '/moderation': 'dashboard.manage_moderation',
  '/moderation/rules': 'dashboard.manage_moderation',
  '/moderation/infractions': 'dashboard.manage_moderation',
  '/tickets': 'dashboard.manage_tickets',
  '/levels': 'dashboard.manage_server',
  '/reaction-roles': 'dashboard.manage_server',
  '/giveaways': 'dashboard.manage_server',
  '/scheduled-messages': 'dashboard.manage_server',
  '/music': 'dashboard.manage_server',
  '/temp-channels': 'dashboard.manage_server',
  '/stats-channels': 'dashboard.manage_server',
  '/embeds': 'dashboard.manage_server',
  '/automations': 'dashboard.manage_automations',
  '/commands': 'dashboard.manage_automations',
  '/store': 'dashboard.manage_store',
  '/store/orders': 'dashboard.manage_orders',
  '/customers': 'dashboard.manage_customers',
  '/licenses': 'dashboard.manage_licenses',
  '/store/promotions': 'dashboard.manage_store',
  '/analytics': 'dashboard.view_analytics',
  '/audit': 'dashboard.view_audit',
  '/diagnostics': 'dashboard.view_diagnostics',
  '/incidents': 'dashboard.manage_incidents',
  '/fraud': 'dashboard.view_fraud',
  '/workflows': 'dashboard.view_workflows',
  '/admin-changes': 'dashboard.undo_changes',
  '/settings': null,
  '/settings/team': 'dashboard.manage_team',
};

// ============================================================
// Permission Helpers
// ============================================================

/**
 * Check if a set of permissions grants access to a specific permission.
 * `dashboard.full_access` is a superuser permission that grants everything.
 */
export function hasPermission(
  userPermissions: DashboardPermission[],
  required: DashboardPermission | null,
): boolean {
  if (required === null) return true;
  if (userPermissions.includes('dashboard.full_access')) return true;
  return userPermissions.includes(required);
}

/**
 * Check if a set of permissions grants access to a specific route.
 */
export function hasRouteAccess(
  userPermissions: DashboardPermission[],
  route: string,
): boolean {
  // Find the most specific matching route
  const matchingRoute = Object.keys(ROUTE_PERMISSIONS)
    .filter((r) => route === r || route.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];

  if (!matchingRoute) return true; // Unknown routes default to accessible
  return hasPermission(userPermissions, ROUTE_PERMISSIONS[matchingRoute]);
}

/**
 * All available dashboard permissions with descriptions.
 */
export const PERMISSION_DESCRIPTIONS: Record<DashboardPermission, string> = {
  'dashboard.full_access': 'Unrestricted access to all dashboard features',
  'dashboard.view_analytics': 'View commerce analytics and reports',
  'dashboard.manage_store': 'Manage store products, plans, and promotions',
  'dashboard.manage_products': 'Create and edit products',
  'dashboard.manage_orders': 'View and manage orders, process refunds',
  'dashboard.manage_customers': 'View and manage customer records',
  'dashboard.manage_licenses': 'Manage license keys and sessions',
  'dashboard.manage_moderation': 'Manage automod rules, infractions, escalation',
  'dashboard.manage_tickets': 'Manage ticket panels and view transcripts',
  'dashboard.manage_automations': 'Create and manage automations and custom commands',
  'dashboard.manage_server': 'Manage server settings, welcome, levels, etc.',
  'dashboard.manage_roles': 'Manage role templates and permissions',
  'dashboard.manage_channels': 'Manage channel templates',
  'dashboard.manage_team': 'Manage dashboard team members and roles',
  'dashboard.view_audit': 'View audit logs',
  'dashboard.view_diagnostics': 'View system diagnostics and health',
  'dashboard.manage_incidents': 'Create and manage incidents',
  'dashboard.view_fraud': 'View fraud signals and reports',
  'dashboard.manage_fraud': 'Manage fraud rules and resolve signals',
  'dashboard.view_workflows': 'View workflow events and dead-letter queue',
  'dashboard.manage_workflows': 'Retry, discard, and manage workflow items',
  'dashboard.undo_changes': 'Undo admin changes and view change history',
};
