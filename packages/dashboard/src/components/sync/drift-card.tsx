'use client';

import { cn } from '@/lib/utils/cn';
import {
  AlertTriangle, AlertOctagon, Info,
  RotateCcw, Check, EyeOff,
  Shield, Hash, Users,
} from 'lucide-react';
import { Badge } from '@/components/shared/badge';
import { Button } from '@/components/shared/button';

// ============================================================
// Types
// ============================================================

export interface DriftCardData {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  entityType: string;
  entityName: string;
  entityDiscordId?: string;
  description: string;
  details?: Record<string, { expected: unknown; actual: unknown }>;
  suggestedAction: 'repair' | 'accept' | 'ignore';
}

interface DriftCardProps {
  item: DriftCardData;
  onRepair: () => void;
  onAccept: () => void;
  onIgnore: () => void;
  loading?: boolean;
}

export const EXTRA_RESOURCE_WARNING =
  'This resource was created outside SomniBot and is not managed yet. Accept adopts it into the managed plan; Ignore dismisses this drift. To delete it, do so deliberately in Discord channel or role management.';

export function canRepairDriftItem(item: Pick<DriftCardData, 'type'>): boolean {
  return item.type !== 'EXTRA_RESOURCE';
}

export function shouldShowRepair(item: Pick<DriftCardData, 'type' | 'suggestedAction'>): boolean {
  return item.suggestedAction === 'repair' && canRepairDriftItem(item);
}

// ============================================================
// Icons & styles
// ============================================================

const severityConfig = {
  critical: {
    Icon: AlertOctagon,
    borderColor: 'border-discord-danger/40',
    bgColor: 'bg-discord-danger/5',
    iconColor: 'text-discord-danger',
    badge: 'danger' as const,
  },
  warning: {
    Icon: AlertTriangle,
    borderColor: 'border-discord-warning/40',
    bgColor: 'bg-discord-warning/5',
    iconColor: 'text-discord-warning',
    badge: 'warning' as const,
  },
  info: {
    Icon: Info,
    borderColor: 'border-discord-accent/30',
    bgColor: 'bg-discord-accent/5',
    iconColor: 'text-discord-accent',
    badge: 'info' as const,
  },
};

const entityIcons: Record<string, React.ElementType> = {
  role: Shield,
  channel: Hash,
  everyone: Users,
  category: Hash,
};

// ============================================================
// Component
// ============================================================

export function DriftCard({ item, onRepair, onAccept, onIgnore, loading }: DriftCardProps) {
  const config = severityConfig[item.severity];
  const EntityIcon = entityIcons[item.entityType] ?? Info;
  const isExtraResource = item.type === 'EXTRA_RESOURCE';

  return (
    <div
      className={cn(
        'rounded-card border p-3',
        config.borderColor,
        config.bgColor,
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <config.Icon size={16} className={cn('mt-0.5 shrink-0', config.iconColor)} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-discord-text-primary">
              {item.entityName}
            </span>
            <EntityIcon size={12} className="text-discord-text-muted" />
            <Badge variant={config.badge}>{item.severity}</Badge>
            <Badge variant="default">{item.type.replace(/_/g, ' ')}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-discord-text-secondary">
            {item.description}
          </p>
          {isExtraResource && (
            <p className="mt-2 rounded-input border border-discord-warning/30 bg-discord-warning/10 p-2 text-xs text-discord-warning">
              {EXTRA_RESOURCE_WARNING}
            </p>
          )}
        </div>
      </div>

      {/* Details */}
      {item.details && Object.keys(item.details).length > 0 && (
        <div className="mt-2 rounded-input bg-discord-bg-tertiary/50 p-2">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-discord-text-muted">
                <th className="pb-1 text-left font-semibold">Property</th>
                <th className="pb-1 text-left font-semibold">Expected</th>
                <th className="pb-1 text-left font-semibold">Actual</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(item.details).map(([key, { expected, actual }]) => (
                <tr key={key}>
                  <td className="py-0.5 text-discord-text-secondary">{key}</td>
                  <td className="py-0.5 font-mono text-discord-success">{String(expected)}</td>
                  <td className="py-0.5 font-mono text-discord-danger">{String(actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 flex items-center gap-2">
        {shouldShowRepair(item) && (
          <Button size="sm" variant="primary" onClick={onRepair} disabled={loading}>
            <RotateCcw size={12} />
            Repair
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onAccept} disabled={loading}>
          <Check size={12} />
          {isExtraResource ? 'Accept (adopt)' : 'Accept'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onIgnore} disabled={loading}>
          <EyeOff size={12} />
          Ignore
        </Button>
      </div>
    </div>
  );
}
