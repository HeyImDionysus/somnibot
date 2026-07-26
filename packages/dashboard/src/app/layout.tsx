import type { Metadata } from 'next';
import '@/styles/globals.css';
import { CsrfBoundary } from '@/components/csrf-boundary';

export const metadata: Metadata = {
  title: 'SomniBot Dashboard',
  description: 'Configure and manage your SomniBot Discord server.',
};

// Every route MUST render per-request, because the middleware serves every
// response with a per-request nonce CSP (script-src 'nonce-…' 'strict-dynamic').
// Next.js injects that nonce into script tags only during dynamic rendering; a
// statically prerendered page is built long before any request exists, ships
// script tags with no nonce, and the browser then blocks every one of them.
//
// That is not a degraded page — it is a dead one: no hydration, no handlers,
// and no console error a user would ever find. The login page shipped exactly
// this way ("Continue with Discord" painted on screen, doing nothing), because
// it happened to be the app's only fully static route.
//
// Static optimisation buys nothing here anyway: this is an authenticated
// dashboard whose configuration is read from runtime env on every request.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-discord-bg-tertiary text-discord-text-primary antialiased">
        <CsrfBoundary />
        {children}
      </body>
    </html>
  );
}
