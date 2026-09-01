import { RuntimeIdentitySchema, type RuntimeIdentity } from '@somnibot/shared';
import { DatabaseRecoveryError, type RecoveryCommand } from './database-recovery-contract.js';

export async function observeRecoveryRuntime(
  query: RecoveryCommand,
  guildId: string,
  run: (command: RecoveryCommand) => Promise<string>,
): Promise<RuntimeIdentity | null> {
  if (!/^\d{17,20}$/.test(guildId)) throw new DatabaseRecoveryError('missing-source-server');
  const sql = `SELECT coalesce((SELECT a.details->'runtimeIdentity'
    FROM public.audit_logs a JOIN public.bot_diagnostics h ON h.guild_id=a.guild_id AND h.type='health'
    WHERE a.guild_id='${guildId}' AND a.action='bot.started' AND a.success IS TRUE
      AND a.details->>'bootId'=h.boot_id::text AND a.timestamp<=h.snapshot_at AND a.timestamp<=clock_timestamp()
      AND h.snapshot_at >= clock_timestamp()-interval '5 minutes'
      AND h.snapshot_at <= clock_timestamp() AND h.valkey_connected IS TRUE AND h.discord_ws_ping >= 0
    ORDER BY a.timestamp DESC,a.id DESC LIMIT 1), 'null'::jsonb);`;
  const value: unknown = JSON.parse(await run({ ...query, args: [...query.args.slice(0, -1), sql] }));
  if (value === null) return null;
  const parsed = RuntimeIdentitySchema.safeParse(value);
  if (!parsed.success) throw new DatabaseRecoveryError('runtime-identity-invalid');
  return parsed.data;
}
