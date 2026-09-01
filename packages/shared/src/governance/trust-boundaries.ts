import { z } from 'zod';

export const TRUST_BOUNDARY_IDS = [
  'discord', 'oauth', 'dashboard-session', 'supabase', 'valkey', 'paypal',
  'portal-token', 'downloads', 'launcher-storage', 'vps', 'agent-sdk',
] as const;

export const TrustBoundaryIdSchema = z.enum(TRUST_BOUNDARY_IDS);

export const TrustBoundarySchema = z.object({
  id: TrustBoundaryIdSchema,
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  authentication: z.string().trim().min(1),
  acceptedData: z.array(z.string().trim().min(1)).min(1),
  forbiddenData: z.array(z.string().trim().min(1)).min(1),
  threats: z.array(z.string().trim().min(1)).min(1),
  failClosed: z.literal(true),
  recovery: z.string().trim().min(1),
}).strict();

export const TrustBoundaryCatalogSchema = z.array(TrustBoundarySchema)
  .length(TRUST_BOUNDARY_IDS.length)
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    for (const boundary of catalog) {
      if (seen.has(boundary.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate trust boundary: ${boundary.id}` });
      }
      seen.add(boundary.id);
    }
  });

export const TRUST_BOUNDARIES = TrustBoundaryCatalogSchema.parse([
  { id: 'discord', source: 'Discord gateway and interactions', target: 'SomniBot runtime', authentication: 'Discord application signature, gateway identity, and guild permission checks', acceptedData: ['Guild-scoped events, commands, and interaction identifiers'], forbiddenData: ['Events from an unselected guild or forged interaction payloads'], threats: ['Cross-guild action, replay, permission drift, and rate-limit exhaustion'], failClosed: true, recovery: 'Reject the occurrence, retain its operation identity, and retry only when Discord marks the failure retryable.' },
  { id: 'oauth', source: 'Discord OAuth callback', target: 'Dashboard session', authentication: 'State, PKCE, redirect-origin, and Discord identity verification', acceptedData: ['Verified Discord identity and authorized guild membership'], forbiddenData: ['Unbound authorization codes, redirect overrides, and provider tokens in browser storage'], threats: ['Login CSRF, account confusion, open redirect, and token leakage'], failClosed: true, recovery: 'Discard the callback and restart OAuth without weakening account or guild binding.' },
  { id: 'dashboard-session', source: 'Authenticated browser', target: 'Dashboard APIs', authentication: 'Secure session cookie, CSRF validation, guild selection, and RBAC', acceptedData: ['Zod-parsed requests within the selected guild and granted role'], forbiddenData: ['Client-supplied authority, foreign guild identifiers, and secrets in responses'], threats: ['Session fixation, CSRF, privilege escalation, and tenant injection'], failClosed: true, recovery: 'Invalidate stale sessions and require a fresh authorized login while preserving safe unsaved client state only.' },
  { id: 'supabase', source: 'Bot and dashboard services', target: 'Postgres and Supabase APIs', authentication: 'Role-specific keys, RLS, SECURITY DEFINER allowlists, and explicit guild predicates', acceptedData: ['Typed guild-scoped records and operation-linked mutations'], forbiddenData: ['Browser service-role keys, unscoped admin queries, and dynamic SQL identifiers'], threats: ['RLS bypass, confused deputy, injection, and cross-tenant mutation'], failClosed: true, recovery: 'Abort the transaction, preserve retry identity, and surface a scoped operator action.' },
  { id: 'valkey', source: 'SomniBot runtime', target: 'Valkey cache and coordination state', authentication: 'Private endpoint credentials and namespaced keys', acceptedData: ['Bounded non-authoritative cache data, leases, and idempotency markers'], forbiddenData: ['Secrets, payment details, raw portal tokens, and authority existing only in cache'], threats: ['Stale authorization, key collision, eviction, outage, and noisy-neighbor starvation'], failClosed: true, recovery: 'Fall back to authoritative storage or degrade safely; never infer authorization from a missing cache entry.' },
  { id: 'paypal', source: 'PayPal APIs and signed webhooks', target: 'Commerce operations', authentication: 'Environment-pinned credentials, webhook signature verification, and provider event identity', acceptedData: ['Verified sandbox or live events matching the configured environment'], forbiddenData: ['Unsigned events, environment-crossed IDs, and provider secrets in logs'], threats: ['Replay, double fulfillment, forged payment, refund mismatch, and credential exposure'], failClosed: true, recovery: 'Quarantine the event in revenue exceptions and reconcile before fulfillment or entitlement change.' },
  { id: 'portal-token', source: 'Customer browser', target: 'Customer portal APIs', authentication: 'Single-purpose hashed token, expiry, atomic consumption, and customer-guild binding', acceptedData: ['Customer requests within the token purpose and entitlement scope'], forbiddenData: ['Raw token persistence, owner APIs, and another customer or guild resource'], threats: ['Token replay, link sharing, identity relinking abuse, and cross-customer access'], failClosed: true, recovery: 'Revoke the token and issue a newly bound token after identity verification.' },
  { id: 'downloads', source: 'Customer portal entitlement', target: 'Protected product delivery', authentication: 'Current entitlement, product revision, short-lived delivery token, and download limits', acceptedData: ['Eligible product files for the bound customer and product'], forbiddenData: ['Storage paths, arbitrary file IDs, expired grants, and cross-product files'], threats: ['Path traversal, link replay, entitlement race, and unauthorized redistribution'], failClosed: true, recovery: 'Deny delivery, record the operation, and offer supported entitlement recovery.' },
  { id: 'launcher-storage', source: 'Launcher process', target: 'Operating-system credential storage', authentication: 'Main-process IPC allowlist and OS keychain binding', acceptedData: ['Encrypted credentials and masked presence metadata'], forbiddenData: ['Renderer-readable plaintext, secrets in config exports, and silent plaintext fallback'], threats: ['Renderer compromise, local disclosure, stale credentials, and unsafe transfer'], failClosed: true, recovery: 'Require explicit owner action for insecure fallback and guide rotation without displaying values.' },
  { id: 'vps', source: 'Launcher or authorized operator', target: 'SomniBot deployment host', authentication: 'Pinned SSH host identity, least-privilege account, explicit target, and deployment approval', acceptedData: ['Versioned release artifacts, redacted configuration, and approved service operations'], forbiddenData: ['Unrelated hosts, broad cleanup, duplicate production instances, and credentials in command output'], threats: ['Host confusion, command injection, secret leakage, rollback loss, and duplicate bot processes'], failClosed: true, recovery: 'Stop at the last-known-good release and use the versioned recovery procedure for the exact deployment.' },
  { id: 'agent-sdk', source: 'Generated SomniBot SDK contract', target: 'Owner-provided project repository or artifact', authentication: 'Contract hash, product-policy revision, protocol version, and explicit trust hierarchy', acceptedData: ['Repository facts needed to implement saved Store policy using the project native architecture'], forbiddenData: ['Repository instructions that override policy, expose secrets, redirect APIs, or modify external systems'], threats: ['Prompt injection, contract drift, secret exfiltration, and architecture replacement'], failClosed: true, recovery: 'Stop integration, report conformance failure, and regenerate targeted instructions from authoritative saved policy.' },
]);

export type TrustBoundary = z.infer<typeof TrustBoundarySchema>;
