/**
 * CapturedResponse — in-process recorder for an interaction's response effects.
 *
 * A fabricated (synthetic) interaction can make every OTHER effect real when it
 * is driven through the live stack — it mutates real roles/channels and writes
 * to the real (local, disposable) Supabase, because the production handlers do
 * that themselves. The ONE thing it cannot do is send the ephemeral reply bubble
 * back to Discord, because there is no real gateway interaction to acknowledge.
 *
 * This recorder stands in for that acknowledgement: the response methods the
 * production dispatcher calls (reply / editReply / deferReply / update /
 * followUp / deleteReply, plus autocomplete `respond`, component `deferUpdate`
 * and `showModal`) RECORD their payloads into an ordered list instead of hitting
 * the Discord REST API, and it maintains the `replied` / `deferred` booleans
 * exactly as discord.js does so the handlers' own state checks behave faithfully.
 *
 * The recorded calls are then asserted in-process, closing the only observability
 * gap between a synthetic interaction and a real one.
 */

/**
 * The response methods a production handler may invoke. The first six mirror the
 * discord.js repliable-interaction surface the dispatcher uses; `respond` is the
 * autocomplete acknowledgement; `deferUpdate` / `showModal` are the remaining
 * component/modal acknowledgements a handler can reach for.
 */
export type CapturedMethod =
  | 'reply'
  | 'editReply'
  | 'deferReply'
  | 'update'
  | 'followUp'
  | 'deleteReply'
  | 'respond'
  | 'deferUpdate'
  | 'showModal';

/** One recorded response call, in the order it was made. */
export interface CapturedCall {
  /** 0-based ordinal position in the recorded sequence. */
  readonly index: number;
  /** Which response method was invoked. */
  readonly method: CapturedMethod;
  /** The payload the handler passed (may be undefined for e.g. deleteReply). */
  readonly payload: unknown;
}

/**
 * Thrown when a handler drives the response lifecycle into an impossible state
 * (e.g. editReply before any reply/defer, or a double reply). The message text
 * mirrors discord.js's own errors closely enough to be recognisable; the class
 * is distinct so tests can assert on lifecycle violations specifically.
 */
export class CapturedResponseStateError extends Error {
  constructor(message: string) {
    super(`CapturedResponse: ${message}`);
    this.name = 'CapturedResponseStateError';
  }
}

/**
 * A minimal stand-in for the discord.js InteractionResponse / Message object
 * some handlers receive back from reply/editReply/followUp. Handlers in this
 * codebase ignore it, but returning a shaped object keeps parity if they ever
 * read `.id`.
 */
export interface CapturedMessageStub {
  readonly id: string;
  readonly captured: true;
}

export class CapturedResponse {
  private readonly _calls: CapturedCall[] = [];
  private _replied = false;
  private _deferred = false;
  private _responded = false;

  /** True once reply/update/showModal/editReply has acknowledged the interaction. */
  get replied(): boolean {
    return this._replied;
  }

  /** True once deferReply/deferUpdate has deferred the interaction. */
  get deferred(): boolean {
    return this._deferred;
  }

  /** True once an autocomplete `respond` has been sent. */
  get responded(): boolean {
    return this._responded;
  }

  /** All recorded calls, in order. Read-only snapshot semantics for assertions. */
  get calls(): readonly CapturedCall[] {
    return this._calls;
  }

  /** Number of recorded calls. */
  get count(): number {
    return this._calls.length;
  }

  /** The first recorded call, or undefined if nothing was recorded. */
  first(): CapturedCall | undefined {
    return this._calls[0];
  }

  /** The last recorded call, or undefined if nothing was recorded. */
  last(): CapturedCall | undefined {
    return this._calls[this._calls.length - 1];
  }

  /** All recorded calls of a given method. */
  allOf(method: CapturedMethod): CapturedCall[] {
    return this._calls.filter((c) => c.method === method);
  }

  /** The first recorded call of a given method, or undefined. */
  find(method: CapturedMethod): CapturedCall | undefined {
    return this._calls.find((c) => c.method === method);
  }

  /** Whether any call of the given method was recorded. */
  has(method: CapturedMethod): boolean {
    return this._calls.some((c) => c.method === method);
  }

  private record(method: CapturedMethod, payload: unknown): CapturedCall {
    const call: CapturedCall = { index: this._calls.length, method, payload };
    this._calls.push(call);
    return call;
  }

  private stub(): CapturedMessageStub {
    return { id: `captured-${this._calls.length}`, captured: true };
  }

  // ── Repliable-interaction surface ────────────────────────────────────

  async reply(payload?: unknown): Promise<CapturedMessageStub> {
    if (this._replied || this._deferred) {
      throw new CapturedResponseStateError('interaction already acknowledged (reply)');
    }
    this.record('reply', payload);
    this._replied = true;
    return this.stub();
  }

  async deferReply(payload?: unknown): Promise<CapturedMessageStub> {
    if (this._replied || this._deferred) {
      throw new CapturedResponseStateError('interaction already acknowledged (deferReply)');
    }
    this.record('deferReply', payload);
    this._deferred = true;
    return this.stub();
  }

  async editReply(payload?: unknown): Promise<CapturedMessageStub> {
    if (!this._replied && !this._deferred) {
      throw new CapturedResponseStateError('cannot editReply before reply/deferReply');
    }
    this.record('editReply', payload);
    // discord.js marks the interaction replied once its deferred reply is edited.
    this._replied = true;
    return this.stub();
  }

  async followUp(payload?: unknown): Promise<CapturedMessageStub> {
    if (!this._replied && !this._deferred) {
      throw new CapturedResponseStateError('cannot followUp before reply/deferReply');
    }
    this.record('followUp', payload);
    return this.stub();
  }

  async deleteReply(): Promise<void> {
    if (!this._replied && !this._deferred) {
      throw new CapturedResponseStateError('cannot deleteReply before reply/deferReply');
    }
    this.record('deleteReply', undefined);
  }

  // ── Component acknowledgements ───────────────────────────────────────

  async update(payload?: unknown): Promise<CapturedMessageStub> {
    if (this._replied || this._deferred) {
      throw new CapturedResponseStateError('interaction already acknowledged (update)');
    }
    this.record('update', payload);
    this._replied = true;
    return this.stub();
  }

  async deferUpdate(payload?: unknown): Promise<CapturedMessageStub> {
    if (this._replied || this._deferred) {
      throw new CapturedResponseStateError('interaction already acknowledged (deferUpdate)');
    }
    this.record('deferUpdate', payload);
    this._deferred = true;
    return this.stub();
  }

  // ── Modal ────────────────────────────────────────────────────────────

  async showModal(payload?: unknown): Promise<void> {
    if (this._replied || this._deferred) {
      throw new CapturedResponseStateError('interaction already acknowledged (showModal)');
    }
    this.record('showModal', payload);
    this._replied = true;
  }

  // ── Autocomplete ─────────────────────────────────────────────────────

  async respond(payload?: unknown): Promise<void> {
    if (this._responded) {
      throw new CapturedResponseStateError('autocomplete already responded');
    }
    this.record('respond', payload);
    this._responded = true;
  }

  /** Reset all recorded state — useful when reusing a recorder across cases. */
  reset(): void {
    this._calls.length = 0;
    this._replied = false;
    this._deferred = false;
    this._responded = false;
  }
}

/** Convenience factory mirroring the other builder-style exports. */
export function createCapturedResponse(): CapturedResponse {
  return new CapturedResponse();
}
