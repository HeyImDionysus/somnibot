import { z } from 'zod';

export const ServiceLifecycleStateSchema = z.enum([
  'uninitialized',
  'initializing',
  'ready',
  'reloading',
  'paused',
  'draining',
  'degraded',
  'recovering',
  'failed',
  'destroyed',
]);
export const SERVICE_LIFECYCLE_STATES = ServiceLifecycleStateSchema.options;
export type ServiceLifecycleState = z.infer<typeof ServiceLifecycleStateSchema>;

const ALLOWED_TRANSITIONS: Readonly<Record<ServiceLifecycleState, readonly ServiceLifecycleState[]>> = {
  uninitialized: ['initializing', 'destroyed'],
  initializing: ['ready', 'degraded', 'failed', 'destroyed'],
  ready: ['reloading', 'paused', 'draining', 'degraded', 'failed'],
  reloading: ['ready', 'degraded', 'failed', 'draining'],
  paused: ['ready', 'draining', 'degraded'],
  draining: ['destroyed', 'failed'],
  degraded: ['recovering', 'paused', 'draining', 'failed'],
  recovering: ['ready', 'degraded', 'failed', 'draining'],
  failed: ['recovering', 'destroyed'],
  destroyed: [],
};

export class InvalidServiceLifecycleTransitionError extends Error {
  readonly from: ServiceLifecycleState;
  readonly to: ServiceLifecycleState;

  constructor(from: ServiceLifecycleState, to: ServiceLifecycleState) {
    super(`Invalid service lifecycle transition: ${from} -> ${to}`);
    this.name = 'InvalidServiceLifecycleTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class ServiceLifecycleController {
  private current: ServiceLifecycleState;

  constructor(initial: ServiceLifecycleState = 'uninitialized') {
    this.current = ServiceLifecycleStateSchema.parse(initial);
  }

  get state(): ServiceLifecycleState {
    return this.current;
  }

  canTransition(next: ServiceLifecycleState): boolean {
    return ALLOWED_TRANSITIONS[this.current].includes(next);
  }

  transition(next: ServiceLifecycleState): ServiceLifecycleState {
    const parsed = ServiceLifecycleStateSchema.parse(next);
    if (!this.canTransition(parsed)) {
      throw new InvalidServiceLifecycleTransitionError(this.current, parsed);
    }
    this.current = parsed;
    return this.current;
  }
}
