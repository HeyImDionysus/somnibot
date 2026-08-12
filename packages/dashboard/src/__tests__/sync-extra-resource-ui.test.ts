import { describe, expect, it } from 'vitest';
import {
  canRepairDriftItem,
  EXTRA_RESOURCE_WARNING as driftCardWarning,
  shouldShowRepair,
} from '@/components/sync/drift-card';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const syncPageSource = readFileSync(
  path.resolve(process.cwd(), 'src/app/(dashboard)/sync/page.tsx'),
  'utf8',
);

describe('EXTRA_RESOURCE sync UI safety', () => {
  it('never exposes Repair for an extra resource, even if stale data suggests repair', () => {
    const extraResource = { type: 'EXTRA_RESOURCE' as const, suggestedAction: 'repair' as const };

    expect(shouldShowRepair(extraResource)).toBe(false);
    expect(canRepairDriftItem(extraResource)).toBe(false);
  });

  it('keeps Repair available for other drift types', () => {
    expect(shouldShowRepair({ type: 'PERMISSION_DRIFT', suggestedAction: 'repair' })).toBe(true);
    expect(canRepairDriftItem({ type: 'PERMISSION_DRIFT' })).toBe(true);
  });

  it('uses an explicit adoption/deletion warning for extra resources', () => {
    expect(driftCardWarning).toContain('Accept adopts it into the managed plan');
    expect(driftCardWarning).toContain('delete it');
    expect(driftCardWarning).toContain('Discord channel or role management');
    expect(syncPageSource).toContain('canRepairDriftItem(item)');
    expect(syncPageSource).toContain('EXTRA_RESOURCE_WARNING');
  });
});
