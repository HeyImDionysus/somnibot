/**
 * Loading Skeletons — Shimmer placeholders for every page type.
 * Prevents the empty flash before data loads.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { cn } from '@/lib/utils/cn';

// ── Base Skeleton ──────────────────────────────────────────

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-discord-bg-tertiary',
        className,
      )}
    />
  );
}

// ── Page-level Skeletons ───────────────────────────────────

/** Dashboard home — stat cards + activity list */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-7 w-40 mb-2" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}

/** Table-based pages (orders, tickets, infractions, customers) */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="h-9 w-48 rounded-md flex-1" />
      </div>
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary">
        {/* Table header */}
        <div className="flex gap-4 border-b border-discord-border-subtle px-4 py-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {/* Table rows */}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex gap-4 border-b border-discord-border-subtle/50 px-4 py-3 last:border-0">
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Card-list pages (giveaways, reaction roles, scheduled messages) */
export function CardListSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: cards }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/** Config/settings pages (levels, music, welcome, etc.) */
export function ConfigSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-7 w-40 mb-2" />
        <Skeleton className="h-4 w-64" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5 space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ))}
      <Skeleton className="h-10 w-24 rounded-md" />
    </div>
  );
}
