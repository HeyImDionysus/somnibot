/**
 * Drift Detection Type Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests DriftType classification and repair routing logic.
 */
import { describe, it, expect } from 'vitest';
import type { DriftType } from '@somnibot/shared';

// Replicate the repair routing logic from sync-engine
type EntityType = 'role' | 'channel' | 'category' | 'everyone';

interface DriftItem {
  type: DriftType;
  entityType: EntityType;
  entityName: string;
  entityDiscordId?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestedAction: string;
  details?: Record<string, unknown>;
}

function canAutoRepair(item: DriftItem): boolean {
  if (item.type === 'MISSING_RESOURCE' && (item.entityType === 'role' || item.entityType === 'channel' || item.entityType === 'category')) {
    return true;
  }
  if ((item.type === 'PERMISSION_DRIFT' || item.type === 'EVERYONE_DRIFT') && (item.entityType === 'role' || item.entityType === 'everyone')) {
    return true;
  }
  // EXTRA_RESOURCE, EXTERNAL_CHANGE, HIERARCHY_DRIFT — manual only
  return false;
}

function classifySeverity(type: DriftType): 'low' | 'medium' | 'high' | 'critical' {
  switch (type) {
    case 'EVERYONE_DRIFT': return 'critical';
    case 'PERMISSION_DRIFT': return 'high';
    case 'MISSING_RESOURCE': return 'high';
    case 'EXTRA_RESOURCE': return 'low';
    case 'HIERARCHY_DRIFT': return 'medium';
    case 'EXTERNAL_CHANGE': return 'low';
    default: return 'low';
  }
}

describe('DriftType Classification', () => {
  it('EVERYONE_DRIFT is critical severity', () => {
    expect(classifySeverity('EVERYONE_DRIFT')).toBe('critical');
  });

  it('PERMISSION_DRIFT is high severity', () => {
    expect(classifySeverity('PERMISSION_DRIFT')).toBe('high');
  });

  it('MISSING_RESOURCE is high severity', () => {
    expect(classifySeverity('MISSING_RESOURCE')).toBe('high');
  });

  it('EXTRA_RESOURCE is low severity', () => {
    expect(classifySeverity('EXTRA_RESOURCE')).toBe('low');
  });
});

describe('Auto-Repair Eligibility', () => {
  it('can auto-repair missing roles', () => {
    expect(canAutoRepair({
      type: 'MISSING_RESOURCE',
      entityType: 'role',
      entityName: 'Moderator',
      severity: 'high',
      description: 'Role deleted',
      suggestedAction: 'Recreate',
    })).toBe(true);
  });

  it('can auto-repair missing channels', () => {
    expect(canAutoRepair({
      type: 'MISSING_RESOURCE',
      entityType: 'channel',
      entityName: 'general',
      severity: 'high',
      description: 'Channel deleted',
      suggestedAction: 'Recreate',
    })).toBe(true);
  });

  it('can auto-repair role permission drift', () => {
    expect(canAutoRepair({
      type: 'PERMISSION_DRIFT',
      entityType: 'role',
      entityName: 'Admin',
      entityDiscordId: '111',
      severity: 'high',
      description: 'Perms changed',
      suggestedAction: 'Restore',
    })).toBe(true);
  });

  it('can auto-repair @everyone drift', () => {
    expect(canAutoRepair({
      type: 'EVERYONE_DRIFT',
      entityType: 'everyone',
      entityName: '@everyone',
      severity: 'critical',
      description: 'Everyone perms changed',
      suggestedAction: 'Restore',
    })).toBe(true);
  });

  it('cannot auto-repair channel permission drift (too complex)', () => {
    expect(canAutoRepair({
      type: 'PERMISSION_DRIFT',
      entityType: 'channel',
      entityName: 'general',
      entityDiscordId: '222',
      severity: 'high',
      description: 'Channel overwrites changed',
      suggestedAction: 'Manual',
    })).toBe(false);
  });

  it('cannot auto-repair extra resources (never auto-delete)', () => {
    expect(canAutoRepair({
      type: 'EXTRA_RESOURCE',
      entityType: 'role',
      entityName: 'Random Role',
      severity: 'low',
      description: 'Extra role',
      suggestedAction: 'Manual cleanup',
    })).toBe(false);
  });

  it('cannot auto-repair hierarchy drift', () => {
    expect(canAutoRepair({
      type: 'HIERARCHY_DRIFT',
      entityType: 'role',
      entityName: 'Bot Role',
      severity: 'medium',
      description: 'Role order changed',
      suggestedAction: 'Manual',
    })).toBe(false);
  });
});
