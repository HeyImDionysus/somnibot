import { completedProjectSpecSchema, type CompletedProjectSpec } from './schema';

export function freezeProject(input: unknown): CompletedProjectSpec {
  const parsed = completedProjectSpecSchema.parse(input);
  return Object.freeze({
    ...parsed,
    build: Object.freeze(parsed.build),
    smoke: Object.freeze(parsed.smoke),
    files: Object.freeze(parsed.files.map((file) => Object.freeze(file))),
    preservedBehaviors: Object.freeze([...parsed.preservedBehaviors]),
    activationSurface: Object.freeze(parsed.activationSurface),
    structuralCapabilities: Object.freeze([...parsed.structuralCapabilities]),
    offlinePolicy: parsed.offlinePolicy === null ? null : Object.freeze(parsed.offlinePolicy),
  });
}
