import { createHash } from 'node:crypto';
import { z } from 'zod';

export const STAFF_AUTHORIZATION_ASSIGNMENT_SELECT =
  'id,guild_id,discord_id,role_id,assigned_at,dashboard_roles(id,guild_id,permissions,updated_at)';

const identityValue = z.string().min(1).max(256);
const assignmentSchema = z.object({
  id: identityValue,
  guild_id: identityValue,
  discord_id: identityValue,
  role_id: identityValue,
  assigned_at: identityValue.nullable(),
  dashboard_roles: z.object({
    id: identityValue,
    guild_id: identityValue,
    permissions: z.array(identityValue).max(1000),
    updated_at: identityValue.nullable(),
  }),
});
const assignmentsSchema = z.array(assignmentSchema).min(1).max(999);

type StaffScope = { readonly guildId: string; readonly actorId: string };
export type StaffAuthorizationAssignment = z.infer<typeof assignmentSchema>;

export function parseStaffAuthorizationAssignments(
  scope: StaffScope,
  rows: unknown,
): readonly StaffAuthorizationAssignment[] | null {
  const parsed = assignmentsSchema.safeParse(rows);
  if (!parsed.success) return null;
  const uniqueIds = new Set(parsed.data.map((row) => row.id));
  if (uniqueIds.size !== parsed.data.length || parsed.data.some((row) =>
    row.guild_id !== scope.guildId || row.discord_id !== scope.actorId
    || row.dashboard_roles.guild_id !== scope.guildId || row.dashboard_roles.id !== row.role_id,
  )) return null;
  return parsed.data.map((row) => ({
    ...row,
    dashboard_roles: { ...row.dashboard_roles, permissions: [...new Set(row.dashboard_roles.permissions)].sort() },
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function staffAuthorizationIdentity(scope: StaffScope, rows: unknown): string | null {
  const assignments = parseStaffAuthorizationAssignments(scope, rows);
  return assignments ? createHash('sha256').update(JSON.stringify(assignments)).digest('hex') : null;
}
