import { z } from 'zod';

export const diagnosticsSettingsSchema = z.object({
  diagnostics_guided_mode: z.boolean().optional(),
  memory_alert_threshold_mb: z.number().int().min(128).max(8192).optional(),
  ws_ping_alert_threshold_ms: z.number().int().min(50).max(10_000).optional(),
  webhook_error_rate_threshold: z.number().min(0).max(1).optional(),
  diagnostics_snapshot_interval_ms: z.number().int().min(15_000).max(600_000).optional(),
}).strict();

const diagnosticsSettingsRowSchema = z.object({
  diagnostics_guided_mode: z.boolean().default(true),
  memory_alert_threshold_mb: z.coerce.number().default(512),
  ws_ping_alert_threshold_ms: z.coerce.number().default(500),
  webhook_error_rate_threshold: z.coerce.number().default(0.25),
  diagnostics_snapshot_interval_ms: z.coerce.number().default(60_000),
});

export type DiagnosticsSettings = {
  readonly guidedMode: boolean;
  readonly thresholds: {
    readonly memoryRssMb: number;
    readonly wsPingMs: number;
    readonly webhookErrorRate: number;
  };
  readonly snapshotIntervalMs: number;
};

export function diagnosticsSettings(row: unknown): DiagnosticsSettings {
  const parsed = diagnosticsSettingsRowSchema.parse(row ?? {});
  return {
    guidedMode: parsed.diagnostics_guided_mode,
    thresholds: {
      memoryRssMb: parsed.memory_alert_threshold_mb,
      wsPingMs: parsed.ws_ping_alert_threshold_ms,
      webhookErrorRate: parsed.webhook_error_rate_threshold,
    },
    snapshotIntervalMs: parsed.diagnostics_snapshot_interval_ms,
  };
}
