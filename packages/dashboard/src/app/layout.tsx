import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'SomniBot Dashboard',
  description: 'Configure and manage your SomniBot Discord server.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-discord-bg-tertiary text-discord-text-primary antialiased">
        {children}
      </body>
    </html>
  );
}
