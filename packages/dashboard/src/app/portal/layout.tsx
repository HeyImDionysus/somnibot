/**
 * Customer Portal layout — separate from admin dashboard.
 * Clean, customer-facing design with minimal navigation.
 *
 * V11 Re-Audit UX-3: Added PortalLogout button so customers can sign out.
 */
import type { Metadata } from 'next';
import { PortalLogout } from '@/components/portal/portal-logout';
import { PortalBrand } from '@/components/portal/portal-brand';

export const metadata: Metadata = {
  title: 'Customer Portal — SomniBot',
  description: 'View your purchases, licenses, and downloads.',
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-discord-bg-primary">
      {/* Top Nav */}
      <header className="sticky top-0 z-40 border-b border-discord-border-subtle bg-discord-bg-secondary/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 break-words text-lg font-bold text-discord-text-primary"><PortalBrand /></span>
            <span className="rounded-full bg-[#FF1493]/20 px-2 py-0.5 text-xs font-medium text-[#FF1493]">Portal</span>
          </div>
          <nav aria-label="Customer portal" className="flex w-full flex-wrap items-center gap-1 sm:w-auto">
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
            <PortalLogout />
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
