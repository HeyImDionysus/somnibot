import Link from 'next/link';

/**
 * Scheduled Messages — Not yet available.
 */
export default function scheduled_messagesPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center">
      <div className="text-center max-w-sm">
        <div className="mb-4 text-5xl">🚧</div>
        <h1 className="text-xl font-bold text-discord-text-primary">
          Scheduled Messages
        </h1>
        <p className="mt-2 text-sm text-discord-text-muted">
          This feature is under development and will be available soon.
        </p>
        <Link
          href="/settings"
          className="mt-4 inline-block rounded-input bg-discord-bg-secondary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary transition-standard"
        >
          Go to Settings
        </Link>
      </div>
    </div>
  );
}
