import { GRADING_SCHEMA, STATIC_FILES_GRADING_SCHEMA } from './contract';
import { CLI_PROJECT } from './fixtures/cli';
import { ELECTRON_PROJECT } from './fixtures/electron';
import { HOSTED_WEB_PROJECT } from './fixtures/hosted-web';
import { PYTHON_PROJECT } from './fixtures/python';
import { RUST_OXIDE_PROJECT } from './fixtures/rust-oxide';
import { STATIC_FILES_PROJECT } from './fixtures/static-files';
import {
  agentTrialExportSchema,
  conformanceBundleSchema,
  type ConformanceBundle,
  type FixtureId,
} from './schema';

export {
  completedProjectSpecSchema,
  agentTrialExportSchema,
  conformanceBundleSchema,
  fixtureIdSchema,
  gradingCriterionIdSchema,
  gradingSchema,
  generatedSdkBundleSchema,
  liveAgentResultSchema,
} from './schema';
export type { ConformanceBundle, FixtureId, LiveAgentResult } from './schema';
export {
  LiveAgentResultValidationError,
  parseAndValidateLiveAgentResult,
  parseLiveAgentResult,
} from './live-agent-results';

export const COMPLETED_PROJECTS = Object.freeze([
  ELECTRON_PROJECT,
  RUST_OXIDE_PROJECT,
  PYTHON_PROJECT,
  HOSTED_WEB_PROJECT,
  CLI_PROJECT,
  STATIC_FILES_PROJECT,
]);

export function generateConformanceBundle(
  fixtureId: FixtureId,
  sdkBundle: unknown,
): ConformanceBundle {
  const fixture = COMPLETED_PROJECTS.find((candidate) => candidate.fixtureId === fixtureId);

  if (fixture === undefined) {
    throw new Error(`Unknown conformance fixture: ${fixtureId}`);
  }
  const grading = fixtureId === 'static-files-site'
    ? STATIC_FILES_GRADING_SCHEMA
    : GRADING_SCHEMA;

  return conformanceBundleSchema.parse({
    bundleVersion: 1,
    fixture,
    sdkBundle,
    grader: {
      ...grading,
      resultSchema: {
        ...grading.resultSchema,
        properties: {
          ...grading.resultSchema.properties,
          fixtureId: { const: fixtureId },
        },
      },
    },
    deterministicReferenceExecution: {
      status: 'runnable',
      evidenceBoundary: 'reference_implementation_not_ai_agent',
      coveredCriteria: grading.criteria.map(({ id }) => id),
    },
    liveAgentExecution: {
      status: 'not_run',
      requiredLater: true,
      evidenceArtifact: null,
    },
  });
}

export function exportConformanceTrial(
  fixtureId: FixtureId,
  sdkBundle: unknown,
): string {
  const bundle = generateConformanceBundle(fixtureId, sdkBundle);
  return JSON.stringify(agentTrialExportSchema.parse({
    trialVersion: 1,
    fixture: bundle.fixture,
    sdkBundle: bundle.sdkBundle,
    grader: bundle.grader,
    execution: {
      kind: 'clean_ai_agent',
      resultFile: 'result.json',
      evidenceDirectory: 'artifacts',
      referenceEvidenceReusable: false,
    },
  }), null, 2);
}
