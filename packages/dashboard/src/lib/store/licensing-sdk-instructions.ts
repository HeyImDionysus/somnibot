import { z } from 'zod';

const statusDecisionSchema = z.object({
  class: z.enum(['live', 'live_warning', 'local_live', 'indeterminate', 'terminal']),
  action: z.string().min(1),
});

export const sdkStatusPolicySchema = z.record(statusDecisionSchema);

export const SDK_STATUS_POLICY = {
  active: { class: 'live', action: 'enable_explicit_features' },
  grace_period: { class: 'live_warning', action: 'enable_until_server_grace_deadline' },
  offline: { class: 'local_live', action: 'continue_within_offline_grace' },
  offline_grace: { class: 'local_live', action: 'continue_within_offline_grace' },
  service_unavailable: { class: 'indeterminate', action: 'retry_without_clearing_valid_cache' },
  rate_limited: { class: 'indeterminate', action: 'honor_retry_after_without_clearing_valid_cache' },
  superseded: { class: 'indeterminate', action: 'ignore_stale_completion' },
  network_error: { class: 'indeterminate', action: 'apply_offline_rules_without_extending_grace' },
  pending_activation: { class: 'terminal', action: 'require_authoritative_activation' },
  pending: { class: 'terminal', action: 'disable_licensed_features' },
  invalid_key: { class: 'terminal', action: 'disable_licensed_features' },
  key_unavailable: { class: 'terminal', action: 'disable_licensed_features' },
  product_mismatch: { class: 'terminal', action: 'disable_licensed_features' },
  device_fingerprint_required: { class: 'terminal', action: 'require_stable_installation_identity' },
  over_device_limit: { class: 'terminal', action: 'require_device_deactivation' },
  guild_membership_required: { class: 'terminal', action: 'require_discord_membership' },
  suspended: { class: 'terminal', action: 'disable_licensed_features' },
  expired: { class: 'terminal', action: 'disable_licensed_features' },
  revoked: { class: 'terminal', action: 'disable_licensed_features' },
  cancelled: { class: 'terminal', action: 'disable_licensed_features' },
  session_invalidated: { class: 'terminal', action: 'clear_session_and_disable_licensed_features' },
  no_session: { class: 'terminal', action: 'validate_before_heartbeat' },
  offline_grace_expired: { class: 'terminal', action: 'clear_cache_and_require_online_validation' },
  destroyed: { class: 'terminal', action: 'reject_operations_after_client_disposal' },
  policy_revision_stale: { class: 'terminal', action: 'apply_targeted_upgrade_and_revalidate' },
  unsupported_protocol: { class: 'terminal', action: 'regenerate_contract_before_integration' },
  conformance_failed: { class: 'terminal', action: 'block_activation_and_record_failed_proof' },
} satisfies Record<string, z.infer<typeof statusDecisionSchema>>;

export const SERVER_LICENSE_STATUSES = [
  'active', 'grace_period', 'service_unavailable', 'rate_limited', 'pending_activation', 'pending',
  'device_fingerprint_required', 'over_device_limit', 'guild_membership_required', 'suspended',
  'expired', 'revoked', 'cancelled', 'session_invalidated',
] as const;

export const implementationStrategySchema = z.object({
  preserveTarget: z.tuple([
    z.literal('language'), z.literal('runtime'), z.literal('architecture'),
    z.literal('packaging'), z.literal('behavior'),
  ]),
  primitives: z.object({
    http: z.literal('target_native'),
    json: z.literal('target_native'),
    crypto: z.literal('target_native_vetted'),
    storage: z.literal('target_native_secure'),
  }),
  runtimeAddition: z.literal('forbidden_when_added_only_for_somnibot'),
  externalBridge: z.literal('only_when_direct_api_communication_is_genuinely_impossible'),
  dynamicProtection: z.literal('runtime_entitlement_enforcement'),
  staticProtection: z.literal('delivery_time_protection'),
}).strict();

export const IMPLEMENTATION_STRATEGY = {
  preserveTarget: ['language', 'runtime', 'architecture', 'packaging', 'behavior'],
  primitives: {
    http: 'target_native', json: 'target_native', crypto: 'target_native_vetted',
    storage: 'target_native_secure',
  },
  runtimeAddition: 'forbidden_when_added_only_for_somnibot',
  externalBridge: 'only_when_direct_api_communication_is_genuinely_impossible',
  dynamicProtection: 'runtime_entitlement_enforcement',
  staticProtection: 'delivery_time_protection',
} as const;

export const agentLifecycleSchema = z.object({
  initialIntegration: z.object({
    instructionScope: z.literal('licensing_contract_and_required_integration_surfaces'),
    preserveExistingBehavior: z.literal(true),
    verifyBuiltArtifact: z.literal(true),
  }),
  upgrade: z.object({
    instructionScope: z.literal('contract_diff_and_affected_integration_surfaces'),
    preserveUnaffectedBehavior: z.literal(true),
    revalidate: z.tuple([
      z.literal('affected_behavior'),
      z.literal('integration_boundaries'),
      z.literal('build_and_behavior_regression'),
    ]),
  }),
}).strict();

export const AGENT_LIFECYCLE = {
  initialIntegration: {
    instructionScope: 'licensing_contract_and_required_integration_surfaces',
    preserveExistingBehavior: true,
    verifyBuiltArtifact: true,
  },
  upgrade: {
    instructionScope: 'contract_diff_and_affected_integration_surfaces',
    preserveUnaffectedBehavior: true,
    revalidate: ['affected_behavior', 'integration_boundaries', 'build_and_behavior_regression'],
  },
} as const;

const outcomeSourceSchema = z.object({
  scope: z.enum(['wire', 'local']),
  statuses: z.array(z.string().min(1)).min(1),
}).strict();

const outcomeSchema = z.object({
  category: z.enum(['live', 'terminal', 'bounded', 'retryable', 'integration']),
  access: z.enum(['grant', 'deny', 'bounded', 'unchanged']),
  sources: z.array(outcomeSourceSchema).min(1),
  action: z.string().min(1),
}).strict();

export const sdkOutcomeModelSchema = z.object({
  valid: outcomeSchema,
  invalid: outcomeSchema,
  revoked: outcomeSchema,
  refunded: outcomeSchema,
  expired: outcomeSchema,
  cancelled: outcomeSchema,
  suspended: outcomeSchema,
  installation_limit_reached: outcomeSchema,
  offline_grace: outcomeSchema,
  retryable_failure: outcomeSchema,
  rate_limited: outcomeSchema,
  policy_revision_stale: outcomeSchema,
  unsupported_protocol: outcomeSchema,
  conformance_failed: outcomeSchema,
}).strict();

export const SDK_OUTCOME_MODEL = {
  valid: { category: 'live', access: 'grant', sources: [{ scope: 'wire', statuses: ['active'] }], action: 'enable_returned_capabilities' },
  invalid: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['revoked'] }], action: 'report_invalid_presented_credential_without_exposing_key_details' },
  revoked: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['revoked'] }], action: 'clear_session_and_disable_licensed_capabilities' },
  refunded: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['revoked'] }], action: 'apply_refund_revocation_and_preserve_customer_data' },
  expired: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['expired'] }], action: 'disable_licensed_capabilities' },
  cancelled: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['cancelled'] }], action: 'disable_licensed_capabilities_at_authoritative_end' },
  suspended: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['suspended'] }], action: 'disable_licensed_capabilities' },
  installation_limit_reached: { category: 'terminal', access: 'deny', sources: [{ scope: 'wire', statuses: ['over_device_limit'] }], action: 'prompt_for_authorized_device_deactivation' },
  offline_grace: { category: 'bounded', access: 'bounded', sources: [{ scope: 'local', statuses: ['offline', 'offline_grace'] }], action: 'continue_only_until_authoritative_grace_deadline' },
  retryable_failure: { category: 'retryable', access: 'unchanged', sources: [{ scope: 'wire', statuses: ['service_unavailable'] }, { scope: 'local', statuses: ['network_error', 'superseded'] }], action: 'retry_without_clearing_prior_valid_cache' },
  rate_limited: { category: 'retryable', access: 'unchanged', sources: [{ scope: 'wire', statuses: ['rate_limited'] }], action: 'honor_retry_after_without_clearing_prior_valid_cache' },
  policy_revision_stale: { category: 'integration', access: 'deny', sources: [{ scope: 'local', statuses: ['policy_revision_stale'] }], action: 'apply_targeted_upgrade_and_revalidate_affected_behavior' },
  unsupported_protocol: { category: 'integration', access: 'deny', sources: [{ scope: 'local', statuses: ['unsupported_protocol'] }], action: 'regenerate_contract_before_integration' },
  conformance_failed: { category: 'integration', access: 'deny', sources: [{ scope: 'local', statuses: ['conformance_failed'] }], action: 'do_not_emit_passing_receipt_or_activate' },
} as const;
