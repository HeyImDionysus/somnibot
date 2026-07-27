/**
 * Diagnostics guided mode — the plain-English layer over the raw metrics.
 *
 * The Diagnostics page reports numbers (RSS in MB, gateway ping in ms,
 * dead-letter depth). To a reader who already knows what "good" looks like
 * that is enough; to a non-technical owner, "RSS 612 MB" is a number with no
 * verdict and no next step.
 *
 * These tests pin the properties that make the guidance worth shipping: every
 * metric the page can explain HAS an explanation, each answers all three
 * questions an owner actually has, and the copy stays free of the jargon the
 * feature exists to remove.
 */
import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTICS_GUIDANCE,
  guidanceFor,
  type GuidedMetric,
} from '@/lib/diagnostics-guidance';

const METRICS = Object.keys(DIAGNOSTICS_GUIDANCE) as GuidedMetric[];

describe('diagnostics guidance', () => {
  it('covers every metric the page renders guidance for', () => {
    // The page renders these four today; adding a <Guidance metric="..."/>
    // without an entry would render nothing and silently lose the explanation.
    for (const metric of ['uptime', 'wsPing', 'memory', 'snapshotStaleness'] as GuidedMetric[]) {
      expect(guidanceFor(metric)).not.toBeNull();
    }
  });

  it('answers all three questions for every metric', () => {
    for (const metric of METRICS) {
      const g = DIAGNOSTICS_GUIDANCE[metric];
      expect(g.plainLanguage.length, `${metric} plainLanguage`).toBeGreaterThan(20);
      expect(g.healthyRange.length, `${metric} healthyRange`).toBeGreaterThan(5);
      expect(g.nextStep.length, `${metric} nextStep`).toBeGreaterThan(20);
    }
  });

  it('describes the metric rather than restating its name', () => {
    for (const metric of METRICS) {
      const g = DIAGNOSTICS_GUIDANCE[metric];
      // A "plain language" line that is just the field name helps nobody.
      expect(g.plainLanguage.trim().toLowerCase()).not.toBe(metric.toLowerCase());
      expect(g.plainLanguage.trim().endsWith('.')).toBe(true);
    }
  });

  it('avoids the jargon the guided mode exists to remove', () => {
    // These are the terms a non-technical owner would have to go and look up.
    const jargon = [' rss', 'heap', 'p95', 'latency percentile', 'ephemeral', 'idempotent'];
    for (const metric of METRICS) {
      const text = [
        DIAGNOSTICS_GUIDANCE[metric].plainLanguage,
        DIAGNOSTICS_GUIDANCE[metric].healthyRange,
      ].join(' ').toLowerCase();
      for (const term of jargon) {
        expect(text, `${metric} explains itself without "${term.trim()}"`).not.toContain(term);
      }
    }
  });

  it('tells the owner what to DO, not just that something is wrong', () => {
    for (const metric of METRICS) {
      const next = DIAGNOSTICS_GUIDANCE[metric].nextStep.toLowerCase();
      // Every next step should point at an action or a place to look.
      const actionable = ['check', 'start', 'open', 'confirm', 'restart', 'raise', 'turn', 'see'];
      expect(
        actionable.some((verb) => next.includes(verb)),
        `${metric} nextStep should suggest an action: "${next}"`,
      ).toBe(true);
    }
  });

  it('does not claim an outage breaks more than it does', () => {
    // Valkey and Lavalink both degrade gracefully — the copy must say so
    // rather than alarming an owner into a 3am restart they do not need.
    expect(DIAGNOSTICS_GUIDANCE.valkey.nextStep.toLowerCase()).toContain('does not break');
    expect(DIAGNOSTICS_GUIDANCE.lavalink.nextStep.toLowerCase()).toContain('nothing else is affected');
  });
});
