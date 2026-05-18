/**
 * Discord UX — Native Discord features for premium bot experience.
 *
 * Context menus, modals, autocomplete, and bot presence.
 */
export { buildContextMenuCommands, handleViewProfile, handleWarnUser, handleViewPurchases, handleCreateTicketFromMessage, handleReportMessage } from './context-menus.js';
export { handleModalSubmit } from './modal-handlers.js';
export { handleAutocomplete } from './autocomplete.js';
export { BotPresenceManager } from './bot-presence.js';
