import { z } from 'zod';
import type { DbGuildDesiredState } from '@somnibot/shared';

type InternalDesiredStateColumn =
  | 'deploy_claim_token'
  | 'deploy_claimed_at'
  | 'deploy_lease_expires_at'
  | 'deploy_error';

type PublicDesiredStateColumn = Exclude<keyof DbGuildDesiredState, InternalDesiredStateColumn>;

export const PUBLIC_DESIRED_STATE_COLUMN_NAMES = [
  'guild_id',
  'roles',
  'channels',
  'categories',
  'permission_map',
  'applied_at',
  'drift_detected',
  'drift_details',
  'last_sync_at',
  'updated_at',
  'deploy_mode',
  'deploy_request_id',
  'deploy_status',
  'deploy_started_at',
  'deploy_completed_at',
] as const satisfies readonly PublicDesiredStateColumn[];

export const PUBLIC_DESIRED_STATE_COLUMNS = PUBLIC_DESIRED_STATE_COLUMN_NAMES.join(', ');

const publicDesiredStateSchema = z.object({
  guild_id: z.string(),
  roles: z.unknown(),
  channels: z.unknown(),
  categories: z.unknown(),
  permission_map: z.unknown(),
  applied_at: z.string().nullable(),
  drift_detected: z.boolean(),
  drift_details: z.unknown(),
  last_sync_at: z.string().nullable(),
  updated_at: z.string(),
  deploy_mode: z.string(),
  deploy_request_id: z.string().nullable(),
  deploy_status: z.string(),
  deploy_started_at: z.string().nullable(),
  deploy_completed_at: z.string().nullable(),
}).partial();

export function toPublicDesiredState(value: unknown) {
  const result = publicDesiredStateSchema.safeParse(value);
  return result.success ? result.data : null;
}
