/**
 * Audit, Diagnostics & Alerting — Phase 13 + Phase C
 *
 * Audit logging for all platform events, periodic health snapshots
 * for the diagnostics dashboard, and threshold-based alerting.
 */
export { AuditService } from './audit-service.js';
export { DiagnosticsService } from './diagnostics-service.js';
export { AlertManager, type AlertThresholds, type HealthSnapshot } from './alert-manager.js';
