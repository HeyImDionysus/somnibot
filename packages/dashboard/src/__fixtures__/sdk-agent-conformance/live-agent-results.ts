import { z } from 'zod';
import {
  liveAgentResultSchema,
  type CompletedProjectSpec,
  type FixtureId,
  type LiveAgentResult,
} from './schema';

const secretScanEvidenceSchema = z.object({
  kind: z.literal('secret_scan'),
  command: z.string().min(1),
  exitCode: z.literal(0),
  scannedPaths: z.array(z.string().min(1)).min(1),
  findings: z.tuple([]),
}).strict();

export type EvidenceArtifactInspection = {
  readonly exists: boolean;
  readonly bytes: number;
  readonly content: string;
};

export type EvidenceArtifactInspector = (
  relativePath: string,
) => Promise<EvidenceArtifactInspection>;

export type ExecutedEvidenceCommand = {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
};

export type EvidenceCommandExecutor = (
  command: CompletedProjectSpec['build'],
) => Promise<ExecutedEvidenceCommand>;

export type LiveAgentEvidenceVerifier = {
  readonly inspectArtifact: EvidenceArtifactInspector;
  readonly executeCommand: EvidenceCommandExecutor;
};

export class LiveAgentResultValidationError extends Error {
  readonly code = 'LIVE_AGENT_RESULT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'LiveAgentResultValidationError';
  }
}

export function parseLiveAgentResult(
  serialized: string,
  expectedFixtureId: FixtureId,
): LiveAgentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new LiveAgentResultValidationError('Live-agent result is not valid JSON.');
  }

  const result = liveAgentResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new LiveAgentResultValidationError('Live-agent result does not match the strict result schema.');
  }
  if (result.data.fixtureId !== expectedFixtureId) {
    throw new LiveAgentResultValidationError('Live-agent result fixture does not match the exported trial.');
  }
  return result.data;
}

export async function parseAndValidateLiveAgentResult(
  serialized: string,
  fixture: CompletedProjectSpec,
  verifier: LiveAgentEvidenceVerifier,
): Promise<LiveAgentResult> {
  const result = parseLiveAgentResult(serialized, fixture.fixtureId);
  const uniqueArtifacts = new Set(result.results.flatMap(({ evidence }) => evidence));
  const inspected = new Map<string, EvidenceArtifactInspection>();
  for (const relativePath of uniqueArtifacts) {
    const artifact = await verifier.inspectArtifact(relativePath);
    if (!artifact.exists || artifact.bytes < 1) {
      throw new LiveAgentResultValidationError(
        `Live-agent evidence is missing or empty: ${relativePath}`,
      );
    }
    inspected.set(relativePath, artifact);
  }

  const [build, smoke] = await Promise.all([
    verifier.executeCommand(fixture.build),
    verifier.executeCommand(fixture.smoke),
  ]);
  const commandsMatch = build.command === fixture.build.command
    && smoke.command === fixture.smoke.command;
  const exitsMatch = build.exitCode === fixture.build.expectedExitCode
    && smoke.exitCode === fixture.smoke.expectedExitCode;
  const observablesMatch = build.output.includes(fixture.build.observable)
    && smoke.output.includes(fixture.smoke.observable);
  if (!commandsMatch || !exitsMatch || !observablesMatch) {
    throw new LiveAgentResultValidationError('Declared build and smoke commands were not independently reproduced.');
  }

  const securityEvidencePaths = result.results.find(
    ({ criterionId }) => criterionId === 'secret_leakage',
  )?.evidence ?? [];
  const hasMachineSecretScan = securityEvidencePaths.some((path) => {
    const artifact = inspected.get(path);
    if (!artifact) return false;
    try {
      return secretScanEvidenceSchema.safeParse(JSON.parse(artifact.content)).success;
    } catch {
      return false;
    }
  });
  if (!hasMachineSecretScan) {
    throw new LiveAgentResultValidationError('Secret-leakage evidence is not a successful machine-readable scan.');
  }
  const securityCorpus = [...inspected.values()].map(({ content }) => content).join('\n');
  if (/SOMNI-SECRET-TEST-KEY|SERVER-DELIVERY-SECRET/i.test(securityCorpus)) {
    throw new LiveAgentResultValidationError('Security evidence contains a test credential or delivery secret.');
  }
  return result;
}
