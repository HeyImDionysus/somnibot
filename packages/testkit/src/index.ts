/**
 * @somnibot/testkit — loopback E2E harness for driving SomniBot's production
 * interaction router against a disposable guild + local Supabase.
 *
 * ⚠️  TEST-BUILD-ONLY. Never import from production code. This package is a
 *     devDependency of the E2E tooling only; the shipped bot bundle has no
 *     import edge to it. See guard.ts for the runtime defense-in-depth.
 */

export {
  assertLoopbackAllowed,
  isLoopbackAllowed,
  LoopbackGuardError,
  LOOPBACK_E2E_CONFIRMATION,
  type LoopbackEnv,
} from './guard.js';

export {
  mintCapabilityToken,
  tokensMatch,
  type CapabilityToken,
} from './capability.js';

export {
  CapturedResponse,
  createCapturedResponse,
  CapturedResponseStateError,
  type CapturedMethod,
  type CapturedCall,
  type CapturedMessageStub,
} from './captured-response.js';

export {
  buildSlashInteraction,
  buildButtonInteraction,
  buildSelectInteraction,
  buildModalInteraction,
  buildAutocompleteInteraction,
  buildUserContextMenuInteraction,
  buildMessageContextMenuInteraction,
  type SyntheticInteraction,
  type SyntheticUser,
  type SyntheticGuild,
  type SyntheticOptions,
  type SyntheticFields,
  type OptionValue,
  type BaseInteractionParams,
  type SlashExtras,
  type BuildSlashParams,
  type BuildButtonParams,
  type BuildSelectParams,
  type BuildModalParams,
  type BuildAutocompleteParams,
  type BuildContextMenuParams,
} from './interaction-builders.js';

export {
  createInteractionInjector,
  InjectorAuthError,
  type InteractionInjector,
  type CreateInjectorOptions,
  type InjectOptions,
} from './inject.js';

export {
  bootstrapLiveClient,
  LiveRunnerError,
  type BootstrapLiveOptions,
  type LiveClientHandle,
  type SeededEconomy,
} from './live-runner.js';
