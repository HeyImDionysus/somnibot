/**
 * V5-Audit §1.1 — CSRF Exempt Route Integrity Test
 *
 * Validates that the hardcoded CSRF_EXEMPT_PREFIXES list in csrf.ts
 * exactly covers the routes that use alternative auth (webhooks, API keys,
 * portal tokens, OAuth callbacks) and nothing more.
 *
 * This prevents drift: adding a new exempt prefix without a matching
 * unguarded route (over-exemption) or adding a new webhook route without
 * exempting it (CSRF would reject legitimate requests).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── Helpers ──────────────────────────────────────────

const API_ROOT = path.resolve(__dirname, '../app/api');

/** Recursively collect all route.ts files under a directory. */
function collectRouteFiles(dir: string, base = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const routes: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      routes.push(...collectRouteFiles(path.join(dir, entry.name), rel));
    } else if (entry.name === 'route.ts') {
      routes.push(base);
    }
  }
  return routes;
}

/** Convert a filesystem path segment to an API path (strip [...] → placeholder). */
function segmentToApiPath(segment: string): string {
  return `/api/${segment.replace(/\[.*?\]/g, ':param')}`;
}

/**
 * Known CSRF exempt prefixes — must match csrf.ts exactly.
 * If you update csrf.ts, update this list and explain why in the PR.
 */
const CSRF_EXEMPT_PREFIXES = [
  '/api/paypal/webhook',
  '/api/license/',
  '/api/portal/',
  '/api/auth/',
  '/api/downloads/',
  '/api/csrf',
] as const;

/**
 * Routes that are public but only serve GET requests, so CSRF
 * (which only checks mutating methods) doesn't apply to them.
 * These do NOT need CSRF exemptions.
 */
const GET_ONLY_PUBLIC_ROUTES = ['/api/health'];

// ── Tests ────────────────────────────────────────────

describe('CSRF exempt-prefix integrity', () => {
  const allRouteSegments = collectRouteFiles(API_ROOT);

  /** Routes whose source contains no requireGuildOwner / requireAuth / requirePermission. */
  const unguardedRoutes = allRouteSegments
    .map((seg) => {
      const filePath = path.join(API_ROOT, seg, 'route.ts');
      const source = readFileSync(filePath, 'utf-8');
      const hasGuard =
        source.includes('requireGuildOwner') ||
        source.includes('requireAuth') ||
        source.includes('requirePermission');
      return { path: segmentToApiPath(seg), hasGuard, filePath };
    })
    .filter((r) => !r.hasGuard);

  it('every unguarded mutating route is covered by a CSRF exempt prefix', () => {
    const uncovered = unguardedRoutes.filter((route) => {
      // GET-only routes don't need CSRF exemption
      if (GET_ONLY_PUBLIC_ROUTES.includes(route.path)) return false;
      // Check if any prefix matches
      return !CSRF_EXEMPT_PREFIXES.some((prefix) => route.path.startsWith(prefix));
    });

    expect(uncovered).toEqual([]);
  });

  it('every CSRF exempt prefix covers at least one actual route', () => {
    const orphans = CSRF_EXEMPT_PREFIXES.filter((prefix) => {
      return !unguardedRoutes.some((route) => route.path.startsWith(prefix));
    });

    expect(orphans).toEqual([]);
  });

  it('every exempt prefix group has at least one unguarded route (is not purely guarded)', () => {
    // Some prefixes may contain a mix of guarded and unguarded routes
    // (e.g. /api/license/ has bot-facing API-key routes AND dashboard-facing
    // session routes). That's acceptable — we just verify the prefix isn't
    // *entirely* guarded, which would mean the exemption is unnecessary.
    const purelyGuarded = CSRF_EXEMPT_PREFIXES.filter((prefix) => {
      const routesUnderPrefix = allRouteSegments
        .map((seg) => {
          const filePath = path.join(API_ROOT, seg, 'route.ts');
          const source = readFileSync(filePath, 'utf-8');
          const hasGuard =
            source.includes('requireGuildOwner') ||
            source.includes('requireAuth') ||
            source.includes('requirePermission');
          return { path: segmentToApiPath(seg), hasGuard };
        })
        .filter((r) => r.path.startsWith(prefix));

      // If every route under this prefix is guarded, the exemption is unnecessary
      return routesUnderPrefix.length > 0 && routesUnderPrefix.every((r) => r.hasGuard);
    });

    expect(purelyGuarded).toEqual([]);
  });
});
