/**
 * In-process capability token.
 *
 * "Loopback-only" means the ONLY way to inject an interaction is a direct
 * in-process function call holding a token minted at adapter construction —
 * there is deliberately no network, HTTP, socket, or event-bus ingress. The
 * token makes the capability un-forgeable by unrelated in-process code that
 * did not construct the adapter, and lets the injector verify it is talking to
 * the exact adapter instance it built.
 */

import { randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

export type CapabilityToken = string & { readonly __brand: 'LoopbackCapabilityToken' };

export function mintCapabilityToken(): CapabilityToken {
  return randomBytes(TOKEN_BYTES).toString('hex') as CapabilityToken;
}

/** Constant-time-ish equality (length-checked) to avoid trivial token probing. */
export function tokensMatch(a: CapabilityToken, b: CapabilityToken): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
