/**
 * /privacy — Public privacy policy page.
 *
 * Audit V2 Finding 13.2 — Data Collection Transparency
 *
 * Accessible without authentication. Describes all data SomniBot collects,
 * why, how long it's kept, and user rights (including /forgetme).
 */

export const metadata = {
  title: 'Privacy Policy — SomniBot',
  description: 'How SomniBot collects, uses, and protects your data.',
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-gray-200">
      <h1 className="mb-2 text-3xl font-bold text-white">Privacy Policy</h1>
      <p className="mb-10 text-sm text-gray-400">Last updated: May 2026</p>

      <Section title="Who We Are">
        <p>
          SomniBot is operated by a sole proprietor. For privacy questions,
          contact us at{' '}
          <a href="mailto:heyimdionysus@gmail.com" className="text-blue-400 underline">
            heyimdionysus@gmail.com
          </a>
          .
        </p>
      </Section>

      <Section title="What Data We Collect">
        <p>SomniBot collects the following data when you interact with the bot or dashboard:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            <strong className="text-white">Discord User ID &amp; Username</strong> — to identify
            you across features (economy, levels, moderation, profiles).
          </li>
          <li>
            <strong className="text-white">Message Counts &amp; Voice Minutes</strong> — to
            calculate XP and level progression. We do not store message content.
          </li>
          <li>
            <strong className="text-white">Economy Data</strong> — wallet balances, inventory,
            transactions, market listings, farm plots, fish catches, adventure sessions, pets,
            quests, achievements, and prestige.
          </li>
          <li>
            <strong className="text-white">Moderation Records</strong> — infractions (warns, mutes,
            kicks, bans) linked to your user ID, with reasons and timestamps.
          </li>
          <li>
            <strong className="text-white">Ticket Transcripts</strong> — messages in support tickets
            you create or participate in, stored for server administration.
          </li>
          <li>
            <strong className="text-white">Purchase Records</strong> — if you buy products through
            the store, we store your Discord ID, entitlements, and PayPal transaction IDs. We do not
            store payment card details.
          </li>
          <li>
            <strong className="text-white">IP Addresses</strong> — logged when you access the
            customer portal, for rate limiting and security purposes.
          </li>
          <li>
            <strong className="text-white">Custom Profile Data</strong> — any profile information
            you voluntarily set (bio, display preferences).
          </li>
        </ul>
      </Section>

      <Section title="Why We Collect It">
        <ul className="list-disc space-y-2 pl-6">
          <li>To provide bot features you interact with (economy, levels, moderation).</li>
          <li>To enforce server rules and maintain moderation records.</li>
          <li>To process purchases and deliver digital products.</li>
          <li>To prevent abuse and enforce rate limits.</li>
          <li>To generate server-level analytics (aggregated, not individual).</li>
        </ul>
      </Section>

      <Section title="Data Storage &amp; Security">
        <p>
          Your data is stored in a Supabase-hosted PostgreSQL database with Row Level Security (RLS)
          policies enforcing guild-scoped access. All connections use TLS encryption. Portal sessions
          use SHA-256 hashed tokens with automatic expiry.
        </p>
      </Section>

      <Section title="Data Retention">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong className="text-white">Economy &amp; level data</strong> — retained until you
            delete it via <Code>/forgetme</Code> or leave the server and the server owner purges
            inactive members.
          </li>
          <li>
            <strong className="text-white">Moderation records</strong> — infractions expire after a
            configurable period (default 30 days). Permanent bans are retained for server safety.
          </li>
          <li>
            <strong className="text-white">Audit logs</strong> — retained for 90 days, then
            automatically pruned.
          </li>
          <li>
            <strong className="text-white">Portal sessions</strong> — automatically deleted after
            expiry.
          </li>
          <li>
            <strong className="text-white">Webhook events</strong> — processed events are pruned
            after 30 days.
          </li>
        </ul>
      </Section>

      <Section title="Your Rights">
        <p>You have the right to:</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            <strong className="text-white">Access your data</strong> — use the{' '}
            <Code>/mydata</Code> command to export all your data as a JSON file.
          </li>
          <li>
            <strong className="text-white">Delete your data</strong> — use the{' '}
            <Code>/forgetme</Code> command to permanently and irreversibly delete all your personal
            data from a server. Tickets and audit logs are anonymized to preserve server integrity.
          </li>
          <li>
            <strong className="text-white">Contact us</strong> — email{' '}
            <a href="mailto:heyimdionysus@gmail.com" className="text-blue-400 underline">
              heyimdionysus@gmail.com
            </a>{' '}
            for any privacy-related requests.
          </li>
        </ul>
      </Section>

      <Section title="Third-Party Services">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong className="text-white">Discord</strong> — we interact with your data through
            Discord&apos;s API. See{' '}
            <a
              href="https://discord.com/privacy"
              className="text-blue-400 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Discord&apos;s Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong className="text-white">PayPal</strong> — if you make purchases, PayPal processes
            the payment. See{' '}
            <a
              href="https://www.paypal.com/us/legalhub/privacy-full"
              className="text-blue-400 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              PayPal&apos;s Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong className="text-white">Supabase</strong> — hosts the database. See{' '}
            <a
              href="https://supabase.com/privacy"
              className="text-blue-400 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Supabase&apos;s Privacy Policy
            </a>
            .
          </li>
        </ul>
      </Section>

      <Section title="Data Sharing">
        <p>
          We do not sell, rent, or share your personal data with third parties. Data is only shared
          with the third-party services listed above as necessary to provide bot functionality.
          Server owners can view aggregated member data through the dashboard but cannot export raw
          personal data beyond what Discord already provides.
        </p>
      </Section>

      <Section title="Children&rsquo;s Privacy">
        <p>
          SomniBot operates within Discord, which requires users to be at least 13 years old. We do
          not knowingly collect data from children under 13.
        </p>
      </Section>

      <Section title="Changes to This Policy">
        <p>
          We may update this policy from time to time. Significant changes will be announced in
          servers using SomniBot. Continued use after changes constitutes acceptance.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 leading-relaxed text-gray-300">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-gray-800 px-1.5 py-0.5 text-sm text-gray-200">{children}</code>
  );
}
