import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { STAFF_AUTHORIZATION_ASSIGNMENT_SELECT, parseStaffAuthorizationAssignments, staffAuthorizationIdentity } from '@/lib/rbac-authorization-identity';

export async function readAdoptionStaffContext(guildId: string) {
  const result = await createAdminSupabase().from('dashboard_user_roles')
    .select(STAFF_AUTHORIZATION_ASSIGNMENT_SELECT).eq('guild_id', guildId).order('id').limit(101);
  if (result.error) return [];
  const rows = z.array(z.object({ discord_id: z.string() }).passthrough()).max(100).safeParse(result.data ?? []);
  if (!rows.success) return [];
  return [...new Set(rows.data.map((row) => row.discord_id))].flatMap((actorId) => {
    const actorRows = rows.data.filter((row) => row.discord_id === actorId);
    const scope = { guildId, actorId };
    const identity = staffAuthorizationIdentity(scope, actorRows);
    const assignments = parseStaffAuthorizationAssignments(scope, actorRows);
    return identity && assignments ? [{ actorId, identity, assignments }] : [];
  });
}
