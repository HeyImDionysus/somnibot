/**
 * Customer Portal layout — separate from admin dashboard.
 * Clean, customer-facing design with minimal navigation.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Customer Portal — SomniBot',
  description: 'View your purchases, licenses, and downloads.',
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-discord-bg-primary">
      {/* Top Nav */}
      <header className="sticky top-0 z-40 border-b border-discord-border-subtle bg-discord-bg-secondary/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-discord-text-primary">SomniBot</span>
            <span className="rounded-full bg-[#FF1493]/20 px-2 py-0.5 text-xs font-medium text-[#FF1493]">Portal</span>
          </div>
          <nav className="flex items-center gap-1">
            <a href="/portal" className="rounded-md px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary hover:bg-discord-bg-tertiary transition-colors">
              Dashboard
            </a>
            <a href="/portal/licenses" className="rounded-md px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary hover:bg-discord-bg-tertiary transition-colors">
              Licenses
            </a>
            <a href="/portal/downloads" className="rounded-md px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary hover:bg-discord-bg-tertiary transition-colors">
              Downloads
            </a>
            <a href="/portal/orders" className="rounded-md px-3 py-1.5 text-sm text-discord-text-secondary hover:text-discord-text-primary hover:bg-discord-bg-tertiary transition-colors">
              Orders
            </a>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        {children}
      </main>
    </div>
  );
}
