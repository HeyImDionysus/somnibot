/**
 * Ticketing System — Phase 7
 *
 * Exports all ticket features for use in event handlers and commands.
 */

export { createTicket, claimTicket, closeTicket, reopenTicket, deleteTicket, addUserToTicket, removeUserFromTicket, checkInactiveTickets } from './ticket-service.js';
export { postPanel, deletePanelMessage } from './panel-manager.js';
export { generateTranscript } from './transcript-generator.js';
export { handleTicketInteraction } from './ticket-interactions.js';
export { ticketCommand, handleTicketCommand } from './ticket-commands.js';
