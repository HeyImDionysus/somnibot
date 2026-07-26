/**
 * Welcome Feature — Onboarding, Welcome, and Goodbye system.
 *
 * Exports:
 * - Onboarding handler (member join/update/leave)
 * - Welcome service (channel message, DM, card, auto-roles)
 * - Goodbye service
 * - Member service (tracking, returning detection)
 * - Welcome card generator (@napi-rs/canvas)
 */

export { handleMemberJoin, handleMemberUpdate, handleMemberLeave, invalidateGuildConfigCache } from './onboarding-handler.js';
export { executeWelcomeFlow } from './welcome-service.js';
export { executeGoodbyeFlow } from './goodbye-service.js';
export { lookupMember, recordMemberJoin, recordMemberLeave, markOnboardingCompleted, getMemberNumber, backfillMembers } from './member-service.js';
export { generateWelcomeCard } from './welcome-card.js';
export { buildWelcomeVariables, interpolateMessage, formatDuration } from './welcome-variables.js';
