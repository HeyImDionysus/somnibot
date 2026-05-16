'use client';

import { createClient } from '@/lib/supabase/client';

/**
 * Login page — Discord OAuth only.
 * Dark theme, centered, minimal.
 */
export default function LoginPage() {
  const handleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback`,
        scopes: 'identify guilds',
      },
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-discord-bg-tertiary">
      <div className="w-full max-w-sm rounded-card bg-discord-bg-primary p-8 shadow-lg">
        {/* Logo / Title */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-discord-text-primary">
            SomniBot
          </h1>
          <p className="mt-2 text-sm text-discord-text-secondary">
            Sign in with Discord to manage your server
          </p>
        </div>

        {/* Discord OAuth Button */}
        <button
          onClick={handleLogin}
          className="flex w-full items-center justify-center gap-3 rounded-input bg-discord-accent px-4 py-3 font-medium text-white transition-standard hover:bg-[#4752c4] active:bg-[#3c45a5]"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          Continue with Discord
        </button>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-discord-text-muted">
          Only the server owner can access the dashboard.
        </p>
      </div>
    </div>
  );
}
