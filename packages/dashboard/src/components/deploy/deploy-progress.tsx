'use client';

import { cn } from '@/lib/utils/cn';
import { CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react';

// ============================================================
// Types
// ============================================================

export interface DeployStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error';
  detail?: string;
  error?: string;
}

interface DeployProgressProps {
  steps: DeployStep[];
  currentStep: number;
  totalSteps: number;
  status: 'idle' | 'running' | 'success' | 'error';
  duration?: number;
}

// ============================================================
// Component
// ============================================================

export function DeployProgress({
  steps,
  currentStep,
  totalSteps,
  status,
  duration,
}: DeployProgressProps) {
  const progressPercent = totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-discord-text-muted">
          <span>
            {status === 'idle' && 'Ready to deploy'}
            {status === 'running' && `Deploying... (${currentStep}/${totalSteps})`}
            {status === 'success' && 'Deployment complete'}
            {status === 'error' && 'Deployment failed'}
          </span>
          {duration !== undefined && (
            <span>{(duration / 1000).toFixed(1)}s</span>
          )}
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-discord-bg-tertiary">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              status === 'running' && 'bg-discord-accent',
              status === 'success' && 'bg-discord-success',
              status === 'error' && 'bg-discord-danger',
              status === 'idle' && 'bg-discord-bg-tertiary',
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Step list */}
      <div className="space-y-1">
        {steps.map((step) => (
          <div
            key={step.id}
            className={cn(
              'flex items-start gap-2 rounded-input px-3 py-1.5 text-sm',
              step.status === 'error' && 'bg-discord-danger/5',
            )}
          >
            {/* Status icon */}
            <div className="mt-0.5 shrink-0">
              {step.status === 'pending' && (
                <Circle size={14} className="text-discord-text-muted/40" />
              )}
              {step.status === 'running' && (
                <Loader2 size={14} className="animate-spin text-discord-accent" />
              )}
              {step.status === 'success' && (
                <CheckCircle2 size={14} className="text-discord-success" />
              )}
              {step.status === 'error' && (
                <XCircle size={14} className="text-discord-danger" />
              )}
            </div>

            {/* Label & detail */}
            <div className="flex-1">
              <p className={cn(
                'text-sm',
                step.status === 'pending' && 'text-discord-text-muted/60',
                step.status === 'running' && 'font-medium text-discord-text-primary',
                step.status === 'success' && 'text-discord-text-secondary',
                step.status === 'error' && 'font-medium text-discord-danger',
              )}>
                {step.label}
              </p>
              {step.detail && (
                <p className="text-xs text-discord-text-muted">{step.detail}</p>
              )}
              {step.error && (
                <p className="mt-0.5 text-xs text-discord-danger">{step.error}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
