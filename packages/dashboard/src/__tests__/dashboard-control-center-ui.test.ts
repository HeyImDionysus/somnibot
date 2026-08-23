import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const controlCenter = readFileSync(resolve(process.cwd(), 'src/components/dashboard/dashboard-control-center.tsx'), 'utf8');
const adoptionMap = readFileSync(resolve(process.cwd(), 'src/components/dashboard/adoption-map.tsx'), 'utf8');
const dashboardPage = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/dashboard/page.tsx'), 'utf8');
const sidebar = readFileSync(resolve(process.cwd(), 'src/components/layout/sidebar.tsx'), 'utf8');

describe('dashboard control-center UI contract', () => {
  it('extends the existing dashboard instead of creating a duplicate control-plane route', () => {
    expect(dashboardPage).toContain('<DashboardControlCenter />');
    expect(controlCenter).toContain('control center');
    expect(controlCenter).not.toContain('/command-center');
  });

  it('keeps search, attention, status, and guild context accessible', () => {
    expect(controlCenter).toContain('htmlFor="dashboard-global-search"');
    expect(controlCenter).toContain('aria-live="polite"');
    expect(controlCenter).toContain('aria-labelledby="attention-heading"');
    expect(controlCenter).toContain('aria-label="Guild context"');
    expect(controlCenter).toContain('min-h-11');
    expect(sidebar).toContain('<GlobalDashboardSearch />');
    expect(controlCenter).toContain("/api/dashboard/control-center?q=");
    expect(controlCenter).toContain('AbortController');
  });

  it('provides mobile-safe track controls and test-before-activation semantics', () => {
    expect(adoptionMap).toContain('grid gap-4 lg:grid-cols-2');
    expect(adoptionMap).toContain('flex flex-wrap');
    expect(adoptionMap).not.toContain('Record test pass');
    expect(adoptionMap).toContain('Verified by recorded feature evidence');
    expect(adoptionMap).toContain('disabled={!verified || dependencies.length > 0}');
    expect(adoptionMap).toContain('Only the server owner can change this map.');
  });
});
