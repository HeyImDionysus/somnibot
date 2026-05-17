/**
 * Setup layout — minimal chrome, no sidebar, no auth required.
 * Used for the first-run setup wizard.
 */
export default function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-discord-bg-primary">
      {children}
    </div>
  );
}
