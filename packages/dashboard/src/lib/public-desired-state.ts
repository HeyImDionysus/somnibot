import { z } from 'zod';

export const PUBLIC_DESIRED_STATE_COLUMNS = [
  'guild_id',
  'roles',
  'channels',
  'categories',
  'permission_map',
  'applied_at',
  'applied_by',
  'drift_detected',
  'drift_details',
  'last_sync_at',
  'updated_at',
  'deploy_mode',
  'deploy_request_id',
  'deploy_status',
  'deploy_requested_at',
  'deploy_started_at',
  'deploy_finished_at',
  'deploy_attempt_count',
].join(', ');

const publicDesiredStateSchema = z.object({
  guild_id: z.string(),
  roles: z.unknown(),
  channels: z.unknown(),
  categories: z.unknown(),
  permission_map: z.unknown(),
  applied_at: z.string().nullable(),
  applied_by: z.string().nullable(),
  drift_detected: z.boolean(),
  drift_details: z.unknown(),
  last_sync_at: z.string().nullable(),
  updated_at: z.string(),
  deploy_mode: z.string(),
  deploy_request_id: z.string().nullable(),
  deploy_status: z.string(),
  deploy_requested_at: z.string().nullable(),
  deploy_started_at: z.string().nullable(),
  deploy_finished_at: z.string().nullable(),
  deploy_attempt_count: z.number(),
}).partial();

export function toPublicDesiredState(value: unknown) {
  const result = publicDesiredStateSchema.safeParse(value);
  return result.success ? result.data : null;
}
