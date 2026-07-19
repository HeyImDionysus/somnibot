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
