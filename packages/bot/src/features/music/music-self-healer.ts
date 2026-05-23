import { createLogger } from '@somnibot/shared';

const log = createLogger('MusicSelfHeal');
/**
 * Music Self-Healer — monitors failure rates and applies recovery strategies.
 *
 * Architecture doc §29.4
 *
 * Uses a sliding window to track YouTube request success/failure rates
 * and escalates through recovery strategies when failures exceed thresholds.
 */

// ── Sliding Window ────────────────────────────────────────

class SlidingWindow {
  private results: boolean[] = [];
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  recordSuccess(): void {
    this.results.push(true);
    if (this.results.length > this.size) this.results.shift();
  }

  recordFailure(): void {
    this.results.push(false);
    if (this.results.length > this.size) this.results.shift();
  }

  get failureRate(): number {
    if (this.results.length === 0) return 0;
    const failures = this.results.filter((r) => !r).length;
    return failures / this.results.length;
  }

  get totalRecords(): number {
    return this.results.length;
  }
}

// ── Self Healer ───────────────────────────────────────────

export type SearchProvider = 'ytsearch' | 'ytmsearch' | 'scsearch';

export class MusicSelfHealer {
  private successRate = new SlidingWindow(100);
  private currentSearchProvider: SearchProvider = 'ytsearch';
  private lastRotationTime = 0;
  private readonly ROTATION_COOLDOWN = 30_000; // 30s between strategy changes

  /** Record a successful track load/play. */
  recordSuccess(): void {
    this.successRate.recordSuccess();
  }

  /** Record a failed track load/play and determine if recovery is needed. */
  recordFailure(): { shouldRecover: boolean; strategy: string | null } {
    this.successRate.recordFailure();

    // Need at least 10 records before analyzing
    if (this.successRate.totalRecords < 10) {
      return { shouldRecover: false, strategy: null };
    }

    const rate = this.successRate.failureRate;
    const now = Date.now();

    // Don't rotate strategies too frequently
    if (now - this.lastRotationTime < this.ROTATION_COOLDOWN) {
      return { shouldRecover: false, strategy: null };
    }

    if (rate > 0.7) {
      this.lastRotationTime = now;
      return { shouldRecover: true, strategy: 'switch_search_provider' };
    }

    if (rate > 0.5) {
      this.lastRotationTime = now;
      return { shouldRecover: true, strategy: 'rotate_client' };
    }

    if (rate > 0.3) {
      this.lastRotationTime = now;
      return { shouldRecover: true, strategy: 'retry_with_delay' };
    }

    return { shouldRecover: false, strategy: null };
  }

  /** Get the current search provider prefix. */
  getSearchProvider(): SearchProvider {
    return this.currentSearchProvider;
  }

  /** Cycle through search providers as a recovery strategy. */
  switchSearchProvider(): SearchProvider {
    const providers: SearchProvider[] = ['ytsearch', 'ytmsearch', 'scsearch'];
    const currentIdx = providers.indexOf(this.currentSearchProvider);
    this.currentSearchProvider = providers[(currentIdx + 1) % providers.length]!;
    log.info(`Switched search provider to: ${this.currentSearchProvider}`);
    return this.currentSearchProvider;
  }

  /** Get current health status. */
  getHealthStatus(): { failureRate: number; searchProvider: SearchProvider; totalRecords: number } {
    return {
      failureRate: this.successRate.failureRate,
      searchProvider: this.currentSearchProvider,
      totalRecords: this.successRate.totalRecords,
    };
  }
}
