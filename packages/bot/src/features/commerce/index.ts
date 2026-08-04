/**
 * Commerce — Phase 12
 *
 * Discord-native storefront with PayPal payments, identity-bound licensing,
 * entitlement lifecycle, and universal license validation.
 */
export { generateLicenseKey, hashLicenseKey } from './key-generator.js';
export { EntitlementService } from './entitlement-service.js';
export { sendReceiptDM, buildReceiptEmbed } from './receipt-builder.js';
export { buildStoreCommand, handleStoreCommand } from './store-command.js';
export { buildLicenseCommand, handleLicenseCommand } from './license-commands.js';
export { handleBuyButton, handleFreeClaimButton } from './payment-handler.js';
