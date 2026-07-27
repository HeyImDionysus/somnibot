/**
 * Public post-checkout landing surface (Finding 7).
 *
 * PayPal's `return_url` / `cancel_url` used to point at `/store?order_complete=true`,
 * which lives under `app/(dashboard)` and is NOT a public route — an
 * unauthenticated buyer was redirected straight to the admin `/login` page. And
 * nothing in the codebase ever read `order_complete` or `order_cancelled`, so
 * even a logged-in owner saw no confirmation. The buyer's only real signal was a
 * Discord DM that silently never arrives when their DMs are closed.
 *
 * These pages live under `/portal`, which the middleware already treats as
 * sessionless-public, so nothing about the admin surface becomes public.
 *
 * WHAT THIS PAGE MAY SHOW
 * -----------------------
 * Nothing customer-specific. The URL is guessable and PayPal appends its own
 * `token` (the PayPal order id) to the return URL; looking an order up by that
 * token would hand anyone who harvests or guesses one another customer's order.
 * So the copy is deliberately generic and points the buyer at the authenticated
 * portal for their actual order, licence keys, and downloads.
 *
 * The only URL input consumed is `?guild=<snowflake>`, which the bot appends and
 * which is validated to digits before being used to build the portal link. It is
 * a public server id, not personal data.
 */
'use client';

import { useEffect, useState } from 'react';

/** Read `?guild=` and keep it only if it looks like a Discord snowflake. */
function readGuildId(): string {
  if (typeof window === 'undefined') return '';
  const raw = new URLSearchParams(window.location.search).get('guild') ?? '';
  return /^\d{1,32}$/.test(raw) ? raw : '';
}

function PortalLink({ guildId }: { guildId: string }) {
  const href = guildId ? `/portal?guild=${encodeURIComponent(guildId)}` : '/portal';
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-input bg-[#FF1493] px-5 py-2.5 text-sm font-medium text-white transition-standard hover:bg-[#FF1493]/80"
    >
      Sign in to your portal
    </a>
  );
}

export function CheckoutComplete() {
  const [guildId, setGuildId] = useState('');
  useEffect(() => setGuildId(readGuildId()), []);

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <div className="rounded-card border border-discord-success/40 bg-discord-bg-secondary p-8 text-center">
        <div className="mb-3 text-5xl" aria-hidden="true">✅</div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Payment received</h1>
        <p className="mt-2 text-sm text-discord-text-secondary">
          Thanks — your PayPal payment went through and your order is being delivered now.
        </p>
      </div>

      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-discord-text-muted">
          What happens next
        </h2>
        <ol className="space-y-3 text-sm text-discord-text-secondary">
          <li className="flex gap-3">
            <span className="font-semibold text-[#FF1493]">1.</span>
            <span>
              The bot sends you a <strong className="text-discord-text-primary">receipt in Discord DMs</strong>,
              usually within a minute. It includes your licence key and download links if your
              purchase came with them.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-[#FF1493]">2.</span>
            <span>
              Any roles or private channels included in your purchase are added to your Discord
              account automatically.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-[#FF1493]">3.</span>
            <span>
              <strong className="text-discord-text-primary">If your Discord DMs are closed</strong>, that
              message cannot reach you — sign in to your customer portal below instead. Everything
              in the receipt is there too.
            </span>
          </li>
        </ol>
      </div>

      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 text-center">
        <p className="mb-4 text-sm text-discord-text-secondary">
          This page cannot show your order details, because it is not signed in. Sign in with
          Discord to see your orders, licence keys, and downloads.
        </p>
        <PortalLink guildId={guildId} />
      </div>

      <p className="text-center text-xs text-discord-text-muted">
        This was a real-money purchase paid through PayPal. It is separate from any in-server
        coin balance you may have, which is not affected. If your receipt has not arrived and
        nothing appears in your portal after a few minutes, contact the server owner with the
        date and amount of your payment.
      </p>
    </div>
  );
}

export function CheckoutCancelled() {
  const [guildId, setGuildId] = useState('');
  useEffect(() => setGuildId(readGuildId()), []);

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center">
        <div className="mb-3 text-5xl" aria-hidden="true">🛒</div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Checkout cancelled</h1>
        <p className="mt-2 text-sm text-discord-text-secondary">
          You have <strong className="text-discord-text-primary">not been charged</strong> and nothing
          was purchased.
        </p>
      </div>

      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <p className="text-sm text-discord-text-secondary">
          If you cancelled by mistake, go back to the store channel in Discord and press
          <strong className="text-discord-text-primary"> Buy</strong> again. The old checkout link is
          no longer valid, so use a fresh one rather than reopening the previous PayPal tab.
        </p>
      </div>

      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 text-center">
        <p className="mb-4 text-sm text-discord-text-secondary">
          Already bought something here before? Your previous orders, licence keys, and downloads
          are in your customer portal.
        </p>
        <PortalLink guildId={guildId} />
      </div>
    </div>
  );
}
