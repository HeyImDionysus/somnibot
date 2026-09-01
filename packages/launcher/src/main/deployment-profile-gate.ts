import {
  DEPLOYMENT_PROFILES,
  evaluateDeploymentProfile,
  selectDeploymentProfile,
  type DeploymentCapacityInput,
  type DeploymentProfileId,
} from '@somnibot/shared';

export type DeploymentProfileGateResult = {
  readonly profile: DeploymentProfileId;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export function evaluateVpsDeploymentProfileGate(
  guildCount: number,
  capacity: DeploymentCapacityInput | undefined,
): DeploymentProfileGateResult {
  const profile = selectDeploymentProfile('vps', guildCount);
  const definition = DEPLOYMENT_PROFILES.find((candidate) => candidate.id === profile);
  if (!definition) throw new RangeError(`Missing deployment profile definition: ${profile}`);
  if (guildCount > definition.maximumGuilds) {
    return {
      profile,
      blockers: [`The higher-load VPS deployment profile supports at most ${definition.maximumGuilds} enabled servers.`],
      warnings: [],
    };
  }
  if (profile === 'higher-load-vps' && capacity === undefined) {
    return {
      profile,
      blockers: ['Higher-load VPS deployment requires measured CPU, memory, backup, capacity, and fairness evidence.'],
      warnings: [],
    };
  }
  if (capacity === undefined) return { profile, blockers: [], warnings: [] };
  if (capacity.guildCount !== guildCount) {
    return { profile, blockers: ['Deployment capacity evidence does not match the enabled server count.'], warnings: [] };
  }
  const compatibility = evaluateDeploymentProfile(profile, capacity);
  return {
    profile,
    blockers: compatibility.blockers.map((blocker) => `Deployment profile requirement failed: ${blocker}.`),
    warnings: compatibility.warnings,
  };
}
