import { ArrowRight, Bot, ExternalLink, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import React from 'react';

export default function SetupHandoffPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-discord-bg-primary px-6 py-12">
      <section className="w-full max-w-2xl rounded-2xl border border-discord-border-subtle bg-discord-bg-secondary p-8 shadow-xl">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-discord-accent">
          <Bot aria-hidden="true" className="h-7 w-7 text-white" />
        </div>

        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-discord-accent">
          Launcher-owned setup
        </p>
        <h1 className="text-3xl font-bold text-discord-text-primary">
          Continue setup in the SomniBot Launcher
        </h1>
        <p className="mt-4 text-discord-text-secondary">
          Installation credentials, database setup, migrations, deployment, and service lifecycle are
          managed only in the Launcher on the machine that owns this installation.
        </p>

        <div className="mt-8 rounded-xl border border-discord-border-subtle bg-discord-bg-tertiary p-5">
          <div className="flex gap-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 flex-none text-green-400" />
            <div>
              <h2 className="font-semibold text-discord-text-primary">This page is read-only</h2>
              <p className="mt-1 text-sm text-discord-text-muted">
                The dashboard does not accept or store setup credentials and cannot run setup or
                migration actions.
              </p>
            </div>
          </div>
        </div>

        <ol className="mt-8 space-y-4 text-discord-text-secondary">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-discord-accent text-sm font-bold text-white">1</span>
            <span>Open the SomniBot Launcher on the installation host.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-discord-accent text-sm font-bold text-white">2</span>
            <span>Complete the Launcher setup and readiness checks there.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-discord-accent text-sm font-bold text-white">3</span>
            <span>Return to the dashboard for server configuration and daily operations.</span>
          </li>
        </ol>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            className="inline-flex items-center gap-2 rounded-lg bg-discord-accent px-4 py-2 font-semibold text-white hover:bg-discord-accent-hover"
            href="/login"
          >
            Go to dashboard login
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
          <Link
            className="inline-flex items-center gap-2 rounded-lg border border-discord-border-subtle px-4 py-2 font-semibold text-discord-text-primary hover:bg-discord-bg-tertiary"
            href="/server-setup"
          >
            Server setup
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
