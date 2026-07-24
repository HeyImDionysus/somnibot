/**
 * Ticket authorization — shared manager-role re-check for lifecycle actions.
 *
 * The catalog permission `manage-ticket-lifecycle` (defaultDecision=deny)
 * contracts that the claim/reopen/delete buttons and the /ticket close|add|remove
 * subcommands re-check manager-role membership at the handler layer. Discord
 * channel visibility is NOT sufficient: the ticket creator — and anyone added via
 * /ticket add — can see the channel yet must not be able to manage the ticket.
 *
 * On denial the caller replies with a branded ephemeral message and emits a
 * `ticket.denied` platform event so the audit pipeline writes a denied-attempt row.
 *
 * Architecture doc §19.
 */
import { PermissionFlagsBits } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TicketTypeConfig } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';

export type TicketLifecycleAction = 'claim' | 'close' | 'reopen' | 'delete' | 'add' | 'remove';

const TICKET_ACTION_VERB: Record<TicketLifecycleAction, string> = {
  claim: 'claim',
  close: 'close',
  reopen: 'reopen',
  delete: 'delete',
  add: 'add members to',
  remove: 'remove members from',
};

/** Branded ephemeral denial copy shown when a non-manager attempts a lifecycle action. */
export function ticketDeniedMessage(action: TicketLifecycleAction): string {
  return `🚫 **Permission denied.** Only ticket managers can ${TICKET_ACTION_VERB[action]} this ticket.`;
}

/**
 * Does `member` hold any of the given role IDs? Handles both a discord.js
 * GuildMemberRoleManager (`roles.cache`, a Collection with `.has`) and a raw
 * role-id array (`APIInteractionGuildMember.roles` / test doubles).
 */
function memberHoldsAnyRole(member: unknown, roleIds: readonly string[]): boolean {
  if (roleIds.length === 0) return false;
  const roles = (member as { roles?: unknown }).roles;
  const cache = (roles as { cache?: { has?: (id: string) => boolean } } | undefined)?.cache;
  if (cache && typeof cache.has === 'function') {
    return roleIds.some((id) => cache.has!(id));
  }
  if (Array.isArray(roles)) {
    return roleIds.some((id) => (roles as unknown[]).includes(id));
  }
  return false;
}

/**
 * Pure role/permission check: a member can manage a ticket if they carry
 * Discord's Manage Server / Manage Channels permission, OR they hold one of the
 * panel's configured manager roles (a per-type override wins when present).
 */
export function memberCanManageTicket(
  member: unknown,
  panelManagerRoles: readonly string[],
  ticketType?: TicketTypeConfig | null,
): boolean {
  if (!member) return false;
  const perms = (member as { permissions?: { has?: (flag: bigint) => boolean } }).permissions;
  if (
    typeof perms?.has === 'function' &&
    (perms.has(PermissionFlagsBits.ManageGuild) || perms.has(PermissionFlagsBits.ManageChannels))
  ) {
    return true;
  }
  const managerRoles =
    ticketType?.managerRoleOverride && ticketType.managerRoleOverride.length > 0
      ? ticketType.managerRoleOverride
      : panelManagerRoles;
  return memberHoldsAnyRole(member, managerRoles);
}

interface TicketAuthzRow {
  panel_id: string | null;
  type: string | null;
  creator_id: string;
}

/**
 * Resolve whether `member` may perform `action` on `ticket`, loading the ticket's
 * panel to read `manager_roles` + the per-type override. The ticket creator may
 * always close their own ticket (per the catalog contract); every other lifecycle
 * action requires manager authority.
 */
export async function canMemberManageTicket(
  supabase: SupabaseClient,
  member: unknown,
  ticket: TicketAuthzRow,
  action: TicketLifecycleAction,
  actorId: string,
): Promise<boolean> {
  // Per contract, a ticket's creator may always close their own ticket.
  if (action === 'close' && ticket.creator_id === actorId) return true;

  let panelManagerRoles: string[] = [];
  let ticketType: TicketTypeConfig | undefined;

  if (ticket.panel_id) {
    const { data: panel } = await supabase
      .from('ticket_panels')
      .select('manager_roles, ticket_types')
      .eq('id', ticket.panel_id)
      .single();
    if (panel) {
      panelManagerRoles = (panel.manager_roles as string[] | null) ?? [];
      const types = (panel.ticket_types as TicketTypeConfig[] | null) ?? [];
      ticketType = types.find((t) => t.id === ticket.type) ?? undefined;
    }
  }

  return memberCanManageTicket(member, panelManagerRoles, ticketType);
}

/**
 * Emit the `ticket.denied` platform event so the audit pipeline writes a
 * denied-attempt row (see EVENT_TO_AUDIT in audit-service.ts).
 */
export function emitTicketDenied(
  eventBus: PlatformEventBus,
  guildId: string,
  ticket: { id: string; ticket_number: number },
  actorId: string,
): void {
  eventBus.emit('ticket.denied', guildId, {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    actorDiscordId: actorId,
    reason: 'permission-denied',
  });
}
