/**
 * Toast / Notification System — Global toast notifications for live events.
 *
 * Usage:
 *   import { useToast } from '@/components/shared/toast';
 *   const { toast } = useToast();
 *   toast({ title: 'Order received', variant: 'success' });
 *
 * Or wrap the app with <ToastProvider> and use the context anywhere.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils/cn';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration?: number; // ms, default 5000
  /** Optional undo callback */
  onUndo?: () => void;
}

interface ToastContextValue {
  toast: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

// ── Context ────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// ── Provider ───────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (t: Omit<Toast, 'id'>): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newToast: Toast = { ...t, id };
      setToasts((prev) => [...prev.slice(-4), newToast]); // max 5 visible

      const duration = t.duration ?? 5000;
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);

      return id;
    },
    [dismiss],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      {/* Render toasts */}
      <div
        className="fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2 pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Toast Item ─────────────────────────────────────────────

const ICONS: Record<ToastVariant, React.ComponentType<{ size?: number; className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLORS: Record<ToastVariant, string> = {
  success: 'border-green-500/40 bg-green-900/40',
  error: 'border-red-500/40 bg-red-900/40',
  warning: 'border-yellow-500/40 bg-yellow-900/40',
  info: 'border-blue-500/40 bg-blue-900/40',
};

const ICON_COLORS: Record<ToastVariant, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-blue-400',
};

function ToastItem({
  toast: t,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const Icon = ICONS[t.variant];

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-right-full fade-in duration-300',
        COLORS[t.variant],
      )}
    >
      <Icon size={18} className={cn('mt-0.5 shrink-0', ICON_COLORS[t.variant])} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-discord-text-primary">{t.title}</p>
        {t.description && (
          <p className="mt-0.5 text-xs text-discord-text-muted">{t.description}</p>
        )}
        {t.onUndo && (
          <button
            onClick={() => {
              t.onUndo?.();
              onDismiss(t.id);
            }}
            className="mt-1 text-xs font-medium text-discord-accent hover:underline"
          >
            Undo
          </button>
        )}
      </div>
      <button
        onClick={() => onDismiss(t.id)}
        className="shrink-0 text-discord-text-muted hover:text-discord-text-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
