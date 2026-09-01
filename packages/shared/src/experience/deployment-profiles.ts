import { z } from 'zod';

export const DeploymentProfileIdSchema = z.enum([
  'local-single-guild',
  'local-multi-guild',
  'vps-single-guild',
  'vps-multi-guild',
  'higher-load-vps',
]);

export const DeploymentProfileSchema = z.object({
  id: DeploymentProfileIdSchema,
  runtime: z.enum(['local', 'vps']),
  guildMode: z.enum(['single', 'multi']),
  maximumGuilds: z.number().int().positive(),
  targetRegisteredMembersPerGuild: z.number().int().positive(),
  minimumCpuCores: z.number().int().positive(),
  minimumMemoryGiB: z.number().int().positive(),
  backupRequired: z.boolean(),
  limitations: z.array(z.string().trim().min(1)),
}).strict();

export type DeploymentProfile = z.infer<typeof DeploymentProfileSchema>;
export type DeploymentProfileId = z.infer<typeof DeploymentProfileIdSchema>;

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = [
  { id: 'local-single-guild', runtime: 'local', guildMode: 'single', maximumGuilds: 1, targetRegisteredMembersPerGuild: 10_000, minimumCpuCores: 2, minimumMemoryGiB: 4, backupRequired: true, limitations: ['The owner device must remain online for continuous service.'] },
  { id: 'local-multi-guild', runtime: 'local', guildMode: 'multi', maximumGuilds: 10, targetRegisteredMembersPerGuild: 10_000, minimumCpuCores: 4, minimumMemoryGiB: 8, backupRequired: true, limitations: ['Resource contention is bounded by the owner device.'] },
  { id: 'vps-single-guild', runtime: 'vps', guildMode: 'single', maximumGuilds: 1, targetRegisteredMembersPerGuild: 10_000, minimumCpuCores: 2, minimumMemoryGiB: 4, backupRequired: true, limitations: ['Valkey and Lavalink must remain private to the deployment.'] },
  { id: 'vps-multi-guild', runtime: 'vps', guildMode: 'multi', maximumGuilds: 25, targetRegisteredMembersPerGuild: 10_000, minimumCpuCores: 4, minimumMemoryGiB: 8, backupRequired: true, limitations: ['Provider and queue capacity must be measured per active guild.'] },
  { id: 'higher-load-vps', runtime: 'vps', guildMode: 'multi', maximumGuilds: 100, targetRegisteredMembersPerGuild: 10_000, minimumCpuCores: 8, minimumMemoryGiB: 16, backupRequired: true, limitations: ['Requires measured workload isolation, backpressure, and restore rehearsal.'] },
].map((profile) => DeploymentProfileSchema.parse(profile));

export type DeploymentCapacityInput = {
  readonly guildCount: number;
  readonly registeredMembersPerGuild: number;
  readonly cpuCores: number;
  readonly memoryGiB: number;
  readonly backupConfigured: boolean;
  readonly fairnessVerified?: boolean;
};

export type DeploymentCompatibility = {
  readonly compatible: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export function evaluateDeploymentProfile(
  id: DeploymentProfileId,
  capacity: DeploymentCapacityInput,
): DeploymentCompatibility {
  const profile = DEPLOYMENT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new RangeError(`Unknown deployment profile: ${id}`);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (capacity.guildCount > profile.maximumGuilds) blockers.push('guild_count');
  if (capacity.cpuCores < profile.minimumCpuCores) blockers.push('cpu_cores');
  if (capacity.memoryGiB < profile.minimumMemoryGiB) blockers.push('memory_gib');
  if (profile.backupRequired && !capacity.backupConfigured) blockers.push('backup_required');
  if (profile.id === 'higher-load-vps' && capacity.fairnessVerified !== true) {
    blockers.push('fairness_verification_required');
  }
  if (capacity.registeredMembersPerGuild > profile.targetRegisteredMembersPerGuild) {
    warnings.push('member_target_exceeded');
  }
  return { compatible: blockers.length === 0, blockers, warnings };
}

export function selectDeploymentProfile(
  runtime: DeploymentProfile['runtime'],
  guildCount: number,
): DeploymentProfileId {
  if (!Number.isInteger(guildCount) || guildCount < 0) {
    throw new RangeError('Guild count must be a non-negative integer');
  }
  if (runtime === 'local') return guildCount <= 1 ? 'local-single-guild' : 'local-multi-guild';
  if (guildCount <= 1) return 'vps-single-guild';
  return guildCount <= 25 ? 'vps-multi-guild' : 'higher-load-vps';
}
