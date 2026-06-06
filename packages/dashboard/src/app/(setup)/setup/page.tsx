'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  Bot,
  Database,
  UserPlus,
  Rocket,
  AlertCircle,
  ChevronRight,
} from 'lucide-react';
import { useCsrf } from '@/hooks/use-csrf';
import { buildSetupRequestHeaders, SETUP_CSRF_UNAVAILABLE_MESSAGE } from '@/lib/setup-wizard-client';

// ============================================================
// Types
// ============================================================

type WizardStep = 1 | 2 | 3 | 4;

interface StepConfig {
  number: WizardStep;
  title: string;
  description: string;
  icon: React.ElementType;
}

interface SetupStatus {
  supabaseConnected: boolean;
  databaseInitialized: boolean;
  botOnline: boolean;
  guildDetected: boolean;
  guildId: string | null;
  guildName: string | null;
  dashboardUrl: string | null;
  discordClientId: string | null;
  setupCompleted?: boolean;
}

const STEPS: StepConfig[] = [
  { number: 1, title: 'Discord Bot', description: 'Create and verify your Discord bot', icon: Bot },
  { number: 2, title: 'Database', description: 'Connect your Supabase project', icon: Database },
  { number: 3, title: 'Invite Bot', description: 'Add the bot to your Discord server', icon: UserPlus },
  { number: 4, title: 'Ready!', description: 'Your SomniBot is live', icon: Rocket },
];

// ============================================================
// Main Component
// ============================================================

export default function SetupWizardPage() {
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { csrfToken, refreshCsrf } = useCsrf();

  // Step 1 state
  const [discordToken, setDiscordToken] = useState('');
  const [discordClientId, setDiscordClientId] = useState('');
  const [discordClientSecret, setDiscordClientSecret] = useState('');
  const [discordVerified, setDiscordVerified] = useState(false);
  const [discordBotName, setDiscordBotName] = useState('');
  const [discordBotAvatar, setDiscordBotAvatar] = useState<string | null>(null);
  const [discordVerifying, setDiscordVerifying] = useState(false);
  const [discordError, setDiscordError] = useState('');

  // Step 2 state
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [supabaseVerified, setSupabaseVerified] = useState(false);
  const [supabaseInitialized, setSupabaseInitialized] = useState(false);
  const [supabaseVerifying, setSupabaseVerifying] = useState(false);
  const [supabaseError, setSupabaseError] = useState('');

  // Step 3 state
  const [inviteUrl, setInviteUrl] = useState('');
  const [pollingForGuild, setPollingForGuild] = useState(false);
  const [guildDetected, setGuildDetected] = useState(false);
  const [guildName, setGuildName] = useState('');
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');

  // Clipboard
  const [copied, setCopied] = useState('');

  // Load initial status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/setup');
      if (res.ok) {
        const data: SetupStatus = await res.json();
        setStatus(data);

        // Auto-advance if things are already configured
        if (data.supabaseConnected && data.databaseInitialized) {
          setSupabaseVerified(true);
          setSupabaseInitialized(true);
          if (data.discordClientId) {
            setDiscordClientId(data.discordClientId);
          }
        }
        if (data.guildDetected && data.guildId) {
          setGuildDetected(true);
          setGuildName(data.guildName || '');
        }
        // If everything is already set up, jump to done
        if (data.supabaseConnected && data.databaseInitialized && data.guildDetected) {
          setCurrentStep(4);
        }
      }
    } catch {
      // Ignore — setup page still renders
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const postSetup = useCallback(async (body: Record<string, unknown>) => {
    let activeHeaders: Record<string, string> = csrfToken ? { 'X-CSRF-Token': csrfToken } : {};

    if (!csrfToken) {
      const refreshed = await refreshCsrf();
      activeHeaders = refreshed ? { 'X-CSRF-Token': refreshed } : {};
    }

    return fetch('/api/setup', {
      method: 'POST',
      headers: buildSetupRequestHeaders(activeHeaders),
      body: JSON.stringify(body),
    });
  }, [csrfToken, refreshCsrf]);

  // ─── Step 1: Verify Discord Credentials ───

  const verifyDiscord = async () => {
    if (!discordToken || !discordClientId) {
      setDiscordError('Bot token and Client ID are required');
      return;
    }
    setDiscordVerifying(true);
    setDiscordError('');
    try {
      const res = await postSetup({
        action: 'verify-discord',
        token: discordToken,
        clientId: discordClientId,
        clientSecret: discordClientSecret,
      });
      const data = await res.json();
      if (data.valid) {
        setDiscordVerified(true);
        setDiscordBotName(data.botUsername);
        setDiscordBotAvatar(data.botAvatar);
      } else {
        setDiscordError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setDiscordError(err instanceof Error ? err.message : `Connection error: ${err}`);
    } finally {
      setDiscordVerifying(false);
    }
  };

  // ─── Step 2: Verify Supabase ───

  const verifySupabase = async () => {
    if (!supabaseUrl || !supabaseKey) {
      setSupabaseError('URL and Service Role Key are required');
      return;
    }
    setSupabaseVerifying(true);
    setSupabaseError('');
    try {
      const res = await postSetup({
        action: 'verify-supabase',
        url: supabaseUrl,
        serviceRoleKey: supabaseKey,
      });
      const data = await res.json();
      if (data.valid) {
        setSupabaseVerified(true);
        setSupabaseInitialized(data.initialized);
      } else {
        setSupabaseError(data.error || 'Connection failed');
      }
    } catch (err) {
      setSupabaseError(err instanceof Error ? err.message : `Connection error: ${err}`);
    } finally {
      setSupabaseVerifying(false);
    }
  };

  // ─── Step 3: Generate Invite & Poll ───

  const generateInvite = async () => {
    const clientId = discordClientId || status?.discordClientId;
    if (!clientId) return;

    try {
      setFinalizeError('');
      const res = await postSetup({ action: 'generate-invite', clientId });
      const data = await res.json();
      if (data.inviteUrl) {
        setInviteUrl(data.inviteUrl);
        window.open(data.inviteUrl, '_blank');
        startPollingForGuild();
      } else if (data.error) {
        setFinalizeError(data.error);
      }
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : SETUP_CSRF_UNAVAILABLE_MESSAGE);
    }
  };

  const finalizeSetup = async () => {
    setFinalizing(true);
    setFinalizeError('');

    try {
      const res = await postSetup({ action: 'finalize' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setFinalizeError(data.error || 'Setup could not be finalized. Check the server logs and try again.');
        return;
      }

      setStatus((prev) => prev ? { ...prev, setupCompleted: true } : prev);
      setCurrentStep(4);
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : SETUP_CSRF_UNAVAILABLE_MESSAGE);
    } finally {
      setFinalizing(false);
    }
  };

  const startPollingForGuild = () => {
    setPollingForGuild(true);
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/setup');
        if (res.ok) {
          const data: SetupStatus = await res.json();
          if (data.guildDetected && data.guildId) {
            setGuildDetected(true);
            setGuildName(data.guildName || '');
            setPollingForGuild(false);
            clearInterval(interval);
          }
        }
      } catch {
        // Continue polling
      }
    }, 5000);

    // Stop polling after 5 minutes
    setTimeout(() => {
      clearInterval(interval);
      setPollingForGuild(false);
    }, 5 * 60 * 1000);
  };

  // ─── Clipboard Helper ───

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  // ─── Loading State ───

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-discord-bg-primary">
        <Loader2 className="h-8 w-8 animate-spin text-discord-accent" />
      </div>
    );
  }

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className="min-h-screen bg-discord-bg-primary flex flex-col">
      {/* Header */}
      <header className="border-b border-discord-border-subtle bg-discord-bg-secondary px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-discord-accent">
            <Bot className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-discord-text-primary">SomniBot Setup</h1>
            <p className="text-sm text-discord-text-muted">Get your bot running in minutes</p>
          </div>
        </div>
      </header>

      {/* Progress Steps */}
      <div className="border-b border-discord-border-subtle bg-discord-bg-secondary/50 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          {STEPS.map((step, i) => {
            const isCompleted = currentStep > step.number;
            const isCurrent = currentStep === step.number;
            const Icon = step.icon;

            return (
              <div key={step.number} className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-all ${
                      isCompleted
                        ? 'bg-green-500 text-white'
                        : isCurrent
                          ? 'bg-discord-accent text-white'
                          : 'bg-discord-bg-tertiary text-discord-text-muted'
                    }`}
                  >
                    {isCompleted ? <CheckCircle2 className="h-5 w-5" /> : step.number}
                  </div>
                  <div className="hidden sm:block">
                    <p
                      className={`text-sm font-medium ${
                        isCurrent ? 'text-discord-text-primary' : 'text-discord-text-muted'
                      }`}
                    >
                      {step.title}
                    </p>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-discord-text-muted mx-2" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step Content */}
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-2xl">
          {/* ─── Step 1: Discord Bot ─── */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-discord-text-primary">Create Your Discord Bot</h2>
                <p className="mt-1 text-discord-text-secondary">
                  You&apos;ll need a Discord bot application. If you already have one, paste the credentials below.
                </p>
              </div>

              {/* Instructions Card */}
              <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-discord-text-muted">
                  How to create a Discord bot
                </h3>
                <ol className="space-y-2 text-sm text-discord-text-secondary">
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">1.</span>
                    <span>
                      Go to the{' '}
                      <a
                        href="https://discord.com/developers/applications"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-discord-accent hover:underline inline-flex items-center gap-1"
                      >
                        Discord Developer Portal <ExternalLink className="h-3 w-3" />
                      </a>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">2.</span>
                    <span>Click &quot;New Application&quot; → name it &quot;SomniBot&quot; → Create</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">3.</span>
                    <span>Go to the &quot;Bot&quot; tab → click &quot;Reset Token&quot; → copy the token</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">4.</span>
                    <span>
                      Enable all three <strong>Privileged Gateway Intents</strong> (Presence, Server Members, Message Content)
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">5.</span>
                    <span>
                      Go to &quot;OAuth2&quot; → copy the <strong>Client ID</strong> and <strong>Client Secret</strong>
                    </span>
                  </li>
                </ol>
              </div>

              {/* Input Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-discord-text-secondary mb-1.5">
                    Bot Token
                  </label>
                  <input
                    type="password"
                    value={discordToken}
                    onChange={(e) => setDiscordToken(e.target.value)}
                    placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
                    className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none focus:ring-1 focus:ring-discord-accent"
                    disabled={discordVerified}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-discord-text-secondary mb-1.5">
                    Client ID (Application ID)
                  </label>
                  <input
                    type="text"
                    value={discordClientId}
                    onChange={(e) => setDiscordClientId(e.target.value)}
                    placeholder="123456789012345678"
                    className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none focus:ring-1 focus:ring-discord-accent"
                    disabled={discordVerified}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-discord-text-secondary mb-1.5">
                    Client Secret
                  </label>
                  <input
                    type="password"
                    value={discordClientSecret}
                    onChange={(e) => setDiscordClientSecret(e.target.value)}
                    placeholder="abcdef123456..."
                    className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none focus:ring-1 focus:ring-discord-accent"
                    disabled={discordVerified}
                  />
                </div>
              </div>

              {/* Error */}
              {discordError && (
                <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {discordError}
                </div>
              )}

              {/* Verified Banner */}
              {discordVerified && (
                <div className="flex items-center gap-3 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3">
                  {discordBotAvatar && (
                    <Image
                      src={discordBotAvatar}
                      alt=""
                      width={40}
                      height={40}
                      unoptimized
                      className="h-10 w-10 rounded-full"
                    />
                  )}
                  <div>
                    <p className="text-sm font-medium text-green-400">
                      <CheckCircle2 className="inline h-4 w-4 mr-1" />
                      Connected as {discordBotName}
                    </p>
                    <p className="text-xs text-green-400/70">Credentials verified &amp; saved</p>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3">
                {!discordVerified ? (
                  <button
                    onClick={verifyDiscord}
                    disabled={discordVerifying || !discordToken || !discordClientId}
                    className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {discordVerifying ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    Verify Credentials
                  </button>
                ) : (
                  <button
                    onClick={() => setCurrentStep(2)}
                    className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/90 transition-colors"
                  >
                    Continue
                    <ChevronRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ─── Step 2: Supabase ─── */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-discord-text-primary">Connect Your Database</h2>
                <p className="mt-1 text-discord-text-secondary">
                  SomniBot uses Supabase for its database. Create a free project and paste the credentials.
                </p>
              </div>

              {/* Instructions Card */}
              <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-discord-text-muted">
                  How to create a Supabase project
                </h3>
                <ol className="space-y-2 text-sm text-discord-text-secondary">
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">1.</span>
                    <span>
                      Go to{' '}
                      <a
                        href="https://supabase.com/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-discord-accent hover:underline inline-flex items-center gap-1"
                      >
                        supabase.com/dashboard <ExternalLink className="h-3 w-3" />
                      </a>{' '}
                      and sign up (free)
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">2.</span>
                    <span>Click &quot;New Project&quot; → name it &quot;somnibot&quot; → set a password → Create</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">3.</span>
                    <span>
                      Go to <strong>Settings → API</strong> → copy the <strong>Project URL</strong>
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-mono text-discord-accent">4.</span>
                    <span>
                      Under &quot;Project API keys&quot;, copy the <strong>secret</strong> key (starts with <code>sb_secret_</code>)
                    </span>
                  </li>
                </ol>
              </div>

              {/* Input Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-discord-text-secondary mb-1.5">
                    Supabase Project URL
                  </label>
                  <input
                    type="url"
                    value={supabaseUrl}
                    onChange={(e) => setSupabaseUrl(e.target.value)}
                    placeholder="https://abcdefg.supabase.co"
                    className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none focus:ring-1 focus:ring-discord-accent"
                    disabled={supabaseVerified}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-discord-text-secondary mb-1.5">
                    Secret Key
                  </label>
                  <input
                    type="password"
                    value={supabaseKey}
                    onChange={(e) => setSupabaseKey(e.target.value)}
                    placeholder="sb_secret_..."
                    className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent focus:outline-none focus:ring-1 focus:ring-discord-accent"
                    disabled={supabaseVerified}
                  />
                </div>
              </div>

              {/* Error */}
              {supabaseError && (
                <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {supabaseError}
                </div>
              )}

              {/* Verified Banner */}
              {supabaseVerified && (
                <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                  <div>
                    <p className="text-sm font-medium text-green-400">Database connected</p>
                    <p className="text-xs text-green-400/70">
                      {supabaseInitialized
                        ? 'Tables are ready — credentials saved'
                        : 'Tables will be created automatically when the bot starts'}
                    </p>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-between">
                <button
                  onClick={() => setCurrentStep(1)}
                  className="inline-flex items-center gap-2 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary transition-colors"
                >
                  Back
                </button>
                <div className="flex gap-3">
                  {!supabaseVerified ? (
                    <button
                      onClick={verifySupabase}
                      disabled={supabaseVerifying || !supabaseUrl || !supabaseKey}
                      className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {supabaseVerifying ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      Verify Connection
                    </button>
                  ) : (
                    <button
                      onClick={() => setCurrentStep(3)}
                      className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/90 transition-colors"
                    >
                      Continue
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ─── Step 3: Invite Bot ─── */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-discord-text-primary">Invite Bot to Your Server</h2>
                <p className="mt-1 text-discord-text-secondary">
                  Click the button below to invite SomniBot to your Discord server. Make sure the bot process is running first.
                </p>
              </div>

              {/* Invite Card */}
              <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-discord-accent/20">
                  <UserPlus className="h-8 w-8 text-discord-accent" />
                </div>
                <button
                  onClick={generateInvite}
                  className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-discord-accent/90 transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  Invite SomniBot to Discord
                </button>

                {inviteUrl && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <span className="text-xs text-discord-text-muted truncate max-w-[300px]">
                      {inviteUrl}
                    </span>
                    <button
                      onClick={() => copyToClipboard(inviteUrl, 'invite')}
                      className="text-discord-text-muted hover:text-discord-text-primary transition-colors"
                    >
                      {copied === 'invite' ? (
                        <Check className="h-3.5 w-3.5 text-green-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Polling indicator */}
              {pollingForGuild && !guildDetected && (
                <div className="flex items-center gap-3 rounded-md border border-discord-accent/30 bg-discord-accent/10 px-4 py-3">
                  <Loader2 className="h-5 w-5 animate-spin text-discord-accent" />
                  <div>
                    <p className="text-sm font-medium text-discord-accent">Waiting for bot to join a server...</p>
                    <p className="text-xs text-discord-accent/70">
                      This will update automatically once the bot detects your server
                    </p>
                  </div>
                </div>
              )}

              {/* Guild detected */}
              {guildDetected && (
                <div className="flex items-center gap-3 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                  <div>
                    <p className="text-sm font-medium text-green-400">
                      Bot is live in {guildName || 'your server'}!
                    </p>
                    <p className="text-xs text-green-400/70">Guild detected and configured</p>
                  </div>
                </div>
              )}

              {finalizeError && (
                <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {finalizeError}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-between">
                <button
                  onClick={() => setCurrentStep(2)}
                  className="inline-flex items-center gap-2 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:text-discord-text-primary transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={finalizeSetup}
                  disabled={!guildDetected || finalizing}
                  className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {finalizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Finalize Setup
                </button>
              </div>
            </div>
          )}

          {/* ─── Step 4: Done ─── */}
          {currentStep === 4 && (
            <div className="space-y-6 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
                <Rocket className="h-10 w-10 text-green-400" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-discord-text-primary">SomniBot is Ready! 🎉</h2>
                <p className="mt-2 text-discord-text-secondary">
                  Your bot is online and connected to {guildName || status?.guildName || 'your server'}.
                  Head to the dashboard to configure features.
                </p>
              </div>

              {/* Quick summary */}
              <div className="mx-auto max-w-sm rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5 text-left">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-discord-text-muted">
                  What&apos;s included
                </h3>
                <ul className="space-y-2 text-sm text-discord-text-secondary">
                  {[
                    'Auto-moderation & tickets',
                    'Levels & XP system',
                    'Music player (Lavalink)',
                    'Reaction roles & custom commands',
                    'Giveaways & scheduled messages',
                    'Commerce & licensing (PayPal)',
                    'Temp & stats channels',
                    'Server sync & automations',
                    'Audit log & diagnostics',
                  ].map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-400 flex-shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>

              <a
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-md bg-discord-accent px-6 py-3 text-sm font-medium text-white hover:bg-discord-accent/90 transition-colors"
              >
                Open Dashboard
                <ChevronRight className="h-4 w-4" />
              </a>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-discord-border-subtle px-6 py-4">
        <p className="text-center text-xs text-discord-text-muted">
          SomniBot — Built with Discord.js, Next.js, Supabase, and Lavalink
        </p>
      </footer>
    </div>
  );
}
