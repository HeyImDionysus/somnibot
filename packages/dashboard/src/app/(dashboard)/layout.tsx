import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { DashboardProviders } from '@/components/layout/dashboard-providers';

/**
 * Dashboard layout — sidebar + content area.
 * Requires authentication — redirects to /login if not signed in.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-discord-bg-primary">
        <div className="mx-auto max-w-5xl p-6">
          <DashboardProviders>
            {children}
          </DashboardProviders>
        </div>
      </main>
    </div>
  );
}
