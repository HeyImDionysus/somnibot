import Link from 'next/link';

export default function ChannelsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-discord-text-primary">Channel management</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Plan changes to your Discord channel structure without creating a second, conflicting editor.</p>
      </header>

      <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="channel-editing-heading">
        <h2 id="channel-editing-heading" className="text-lg font-medium text-discord-text-primary">Edit the staged channel plan</h2>
        <p className="mt-2 text-sm text-discord-text-secondary">Channel creation, edits, and deletion warnings live in Server setup. Changes are staged there first, then deployed by SomniBot. A queued change is not live until the bot applies it and publishes a fresh Discord snapshot.</p>
        <Link href="/server-setup?step=3" className="mt-4 inline-flex rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover">
          Open channel setup
        </Link>
      </section>

      <section className="rounded-card border border-discord-warning/40 bg-discord-warning/10 p-5" aria-labelledby="channel-warning-heading">
        <h2 id="channel-warning-heading" className="text-lg font-medium text-discord-text-primary">Deploy and verify deliberately</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-discord-text-secondary">
          <li>Review staged channel changes and their target names in Server setup.</li>
          <li>Deploy the plan, then wait for SomniBot to process the queue.</li>
          <li>Confirm the fresh snapshot and any destination-dependent feature before treating it as live.</li>
        </ol>
        <p className="mt-3 text-xs text-discord-text-muted">Deletion is irreversible in Discord: deleted channels also remove their message history. The setup step keeps that warning next to the destructive action.</p>
      </section>
    </div>
  );
}
