import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { createServerSupabase } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { DashboardProviders } from '@/components/layout/dashboard-providers';
import { Breadcrumb } from '@/components/shared/breadcrumb';
import { BotStatusBanner } from '@/components/layout/bot-status-banner';
import { FeatureStatusPanel } from '@/components/layout/feature-status-panel';

/**
 * Dashboard layout — sidebar + content area with breadcrumbs.
 * Requires authentication — redirects to /login if not signed in.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localMode = process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE === '1';
  const localToken = process.env.SESSION_TOKEN;
  if (localMode && localToken) {
    const requestHeaders = await headers();
    const host = requestHeaders.get('host') ?? '';
    const localHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
    const localSession = (await cookies()).get('somnibot-local-session')?.value;
    if (!localHost || localSession !== localToken) {
      redirect('/login');
    }
  } else {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      redirect('/login');
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* V53 Phase 2: Bot offline/stale banner */}
        <BotStatusBanner />
        <main className="flex-1 overflow-y-auto bg-discord-bg-primary">
          <div className="mx-auto max-w-5xl p-6">
            <DashboardProviders>
              <Breadcrumb />
              <FeatureStatusPanel />
              {children}
            </DashboardProviders>
          </div>
        </main>
      </div>
    </div>
  );
}
