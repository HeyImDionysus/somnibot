import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Setup page — the first page the owner sees after login.
 * Guides through initial bot configuration:
 * 1. Verify bot invite + role position
 * 2. Server structure (roles/channels)
 * 3. Permission mapping
 * 4. Deploy
 *
 * Full implementation in Phase 2. This is the skeleton.
 */
export default async function SetupPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div>
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-discord-text-primary">
          Server Setup
        </h1>
        <p className="mt-1 text-sm text-discord-text-secondary">
          Configure your server structure, roles, and permissions.
        </p>
      </div>

      {/* Setup Steps */}
      <div className="space-y-4">
        {/* Step 1: Bot Status */}
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-discord-accent text-sm font-bold text-white">
              1
            </div>
            <div>
              <h2 className="font-semibold text-discord-text-primary">
                Bot Status
              </h2>
              <p className="text-sm text-discord-text-muted">
                Verify the bot is in your server with the correct role position.
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-input bg-discord-bg-tertiary p-4">
            <div className="flex items-center gap-2 text-sm">
              <div className="h-2 w-2 rounded-full bg-discord-text-muted" />
              <span className="text-discord-text-muted">
                Checking bot status...
              </span>
            </div>
          </div>
        </div>

        {/* Step 2: Server Structure */}
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 opacity-50">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-discord-bg-tertiary text-sm font-bold text-discord-text-muted">
              2
            </div>
            <div>
              <h2 className="font-semibold text-discord-text-secondary">
                Server Structure
              </h2>
              <p className="text-sm text-discord-text-muted">
                Define your role hierarchy and channel layout.
              </p>
            </div>
          </div>
        </div>

        {/* Step 3: Permissions */}
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 opacity-50">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-discord-bg-tertiary text-sm font-bold text-discord-text-muted">
              3
            </div>
            <div>
              <h2 className="font-semibold text-discord-text-secondary">
                Permissions
              </h2>
              <p className="text-sm text-discord-text-muted">
                Map role templates to channel templates.
              </p>
            </div>
          </div>
        </div>

        {/* Step 4: Deploy */}
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 opacity-50">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-discord-bg-tertiary text-sm font-bold text-discord-text-muted">
              4
            </div>
            <div>
              <h2 className="font-semibold text-discord-text-secondary">
                Deploy
              </h2>
              <p className="text-sm text-discord-text-muted">
                Review changes and deploy to your server.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
