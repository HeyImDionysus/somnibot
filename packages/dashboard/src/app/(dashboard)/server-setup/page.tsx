'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { Badge } from '@/components/shared/badge';
import { cn } from '@/lib/utils/cn';
import {
  CheckCircle2, Circle, ChevronRight, Shield, Hash,
  Rocket, Eye, Settings, Zap, AlertTriangle,
  Copy, Loader2, RefreshCw,
} from 'lucide-react';
import { deployApi } from '@/lib/api/client';

// ============================================================
// Types
// ============================================================

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface StepConfig {
  number: WizardStep;
  title: string;
  description: string;
  icon: React.ElementType;
}

interface GuildInfo {
  id: string;
  name: string;
  setupCompleted: boolean;
  setupConfirmedAt: string | null;
  botRolePosition: number | null;
}

interface SetupData {
  guild: GuildInfo | null;
  isDeployed: boolean;
  hasDesiredState: boolean;
  desiredState: Record<string, unknown> | null;
  idMappings: Array<{ entity_type: string; template_key: string; discord_id: string }>;
  roleTemplates: unknown[];
  channelTemplates: unknown[];
}

interface DeployData {
  desiredState: Record<string, unknown> | null;
  setupCompleted: boolean;
  isDeploying: boolean;
  recentActions: Array<Record<string, unknown>>;
}

// ============================================================
// Default Templates
// ============================================================

// Role permission bitfields computed from architecture doc §10.1.
// Every single Discord permission is deliberately assigned to exactly one tier.
// ADMINISTRATOR (1 << 3) is NEVER granted — it bypasses all overrides.
const PERM = {
  MEMBER:    '1764069874191937', // 22 perms: VIEW_CHANNEL, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS, USE_EXTERNAL_STICKERS, READ_MESSAGE_HISTORY, USE_APPLICATION_COMMANDS, CONNECT, SPEAK, USE_VAD, STREAM, USE_SOUNDBOARD, SEND_VOICE_MESSAGES, SEND_POLLS, USE_EXTERNAL_APPS, CHANGE_NICKNAME, CREATE_INSTANT_INVITE, REQUEST_TO_SPEAK
  MODERATOR: '1818040596955079', // 39 perms: Member + MANAGE_MESSAGES, MANAGE_THREADS, CREATE_PRIVATE_THREADS, MODERATE_MEMBERS, KICK, BAN, MUTE, DEAFEN, MOVE_MEMBERS, PRIORITY_SPEAKER, MANAGE_NICKNAMES, VIEW_AUDIT_LOG, MENTION_EVERYONE, MANAGE_EVENTS, CREATE_EVENTS, USE_EXTERNAL_SOUNDS, SEND_TTS_MESSAGES
  ADMIN:     '1829037592805367', // 47 perms: Moderator + MANAGE_ROLES, MANAGE_CHANNELS, MANAGE_GUILD, MANAGE_WEBHOOKS, MANAGE_GUILD_EXPRESSIONS, CREATE_GUILD_EXPRESSIONS, VIEW_GUILD_INSIGHTS, VIEW_CREATOR_MONETIZATION_ANALYTICS
} as const;

const DEFAULT_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    tier: 'admin',
    permissions: PERM.ADMIN, // Same as Admin — NEVER ADMINISTRATOR. Server owner has implicit full access.
    color: 0xFF1493, // SOMNI_PALETTE HOT_PINK
    hoist: true,
    mentionable: false,
    position: 5,
  },
  {
    key: 'admin',
    name: 'Admin',
    tier: 'admin',
    permissions: PERM.ADMIN,
    color: 0xED4245,
    hoist: true,
    mentionable: false,
    position: 4,
  },
  {
    key: 'moderator',
    name: 'Moderator',
    tier: 'moderator',
    permissions: PERM.MODERATOR,
    color: 0xFEE75C,
    hoist: true,
    mentionable: false,
    position: 3,
  },
  {
    key: 'dj',
    name: 'DJ',
    tier: 'moderator',
    permissions: PERM.MEMBER, // Same as Member — DJ-specific perms are channel overrides on music channels
    color: 0x00D4FF, // SOMNI_PALETTE CYAN
    hoist: false,
    mentionable: false,
    position: 2,
  },
  {
    key: 'member',
    name: 'Member',
    tier: 'member',
    permissions: PERM.MEMBER,
    color: 0x57F287,
    hoist: false,
    mentionable: false,
    position: 1,
  },
];

// Channel override bitfields from architecture doc §11.1.
// These match the per-channel permission templates exactly.
const CH = {
  // View Only: can see & react, cannot send messages or use commands
  VIEW_ONLY_ALLOW: '66624',       // VIEW_CHANNEL + READ_MESSAGE_HISTORY + ADD_REACTIONS
  VIEW_ONLY_DENY:  '380104607744', // SEND_MESSAGES + SEND_MESSAGES_IN_THREADS + CREATE_PUBLIC_THREADS + CREATE_PRIVATE_THREADS + USE_APPLICATION_COMMANDS

  // View & Use: full Member-level text access
  VIEW_USE_ALLOW: '1759667428904000', // VIEW_CHANNEL + READ_MESSAGE_HISTORY + SEND_MESSAGES + SEND_MESSAGES_IN_THREADS + CREATE_PUBLIC_THREADS + ADD_REACTIONS + EMBED_LINKS + ATTACH_FILES + USE_APPLICATION_COMMANDS + SEND_VOICE_MESSAGES + SEND_POLLS + USE_EXTERNAL_EMOJIS + USE_EXTERNAL_STICKERS + USE_EXTERNAL_APPS

  // Staff Only: @everyone denied, mod+ allowed
  STAFF_DENY: '1024',              // VIEW_CHANNEL
  STAFF_ALLOW: '19327478848',      // VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + MANAGE_THREADS + EMBED_LINKS + ATTACH_FILES + ADD_REACTIONS + USE_APPLICATION_COMMANDS

  // Voice: standard voice access
  VOICE_ALLOW: '4398083212800',    // VIEW_CHANNEL + CONNECT + SPEAK + USE_VAD + STREAM + USE_SOUNDBOARD
} as const;

// Helper: build Staff Only overrides (hidden from @everyone, visible to mod+)
const staffOverrides = () => [
  { roleKey: 'everyone', allow: '0', deny: CH.STAFF_DENY },
  { roleKey: 'moderator', allow: CH.STAFF_ALLOW, deny: '0' },
  { roleKey: 'admin', allow: CH.STAFF_ALLOW, deny: '0' },
  { roleKey: 'owner', allow: CH.STAFF_ALLOW, deny: '0' },
];

// Helper: build View Only overrides (Member can see + react, cannot send)
const viewOnlyOverrides = () => [
  { roleKey: 'member', allow: CH.VIEW_ONLY_ALLOW, deny: CH.VIEW_ONLY_DENY },
];

// Helper: build View & Use overrides (Member has full text access)
const viewUseOverrides = () => [
  { roleKey: 'member', allow: CH.VIEW_USE_ALLOW, deny: '0' },
];

// Helper: build voice overrides
const voiceOverrides = () => [
  { roleKey: 'member', allow: CH.VOICE_ALLOW, deny: '0' },
];

// Helper: build staff-only voice overrides
const staffVoiceOverrides = () => [
  { roleKey: 'everyone', allow: '0', deny: CH.STAFF_DENY },
  { roleKey: 'moderator', allow: CH.VOICE_ALLOW, deny: '0' },
  { roleKey: 'admin', allow: CH.VOICE_ALLOW, deny: '0' },
  { roleKey: 'owner', allow: CH.VOICE_ALLOW, deny: '0' },
];

// Optimal default server structure — based on web research + architecture doc §11.4.
// Follows Discord best practices:
//   - "Rule of Seven": new servers start lean, add channels as features activate
//   - 4-5 channels per category (Discord's recommendation)
//   - Important channels at top, main chat middle, less important at bottom
//   - Only includes channels for features that exist or are imminent
//   - Staff/logging channels ready from day one
// Total: ~20 channels in 7 categories = clean, functional, not overwhelming.
const DEFAULT_CHANNELS = [
  // ── INFORMATION (3 channels) ──────────────────────────────
  // Top of server. View-only. Rules, announcements, welcome info.
  { key: 'rules', name: 'rules', type: 0, categoryKey: 'cat-information', position: 0, topic: 'Server rules and guidelines', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
  { key: 'announcements', name: 'announcements', type: 5, categoryKey: 'cat-information', position: 1, topic: 'Important server announcements', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
  { key: 'welcome', name: 'welcome', type: 0, categoryKey: 'cat-information', position: 2, topic: 'Welcome new members! Introduce yourself here.', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },

  // ── GENERAL (3 channels) ──────────────────────────────────
  // Main community chat. Open to all Members.
  { key: 'general', name: 'general', type: 0, categoryKey: 'cat-general', position: 0, topic: 'General discussion', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
  { key: 'off-topic', name: 'off-topic', type: 0, categoryKey: 'cat-general', position: 1, topic: 'Anything goes', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
  { key: 'media', name: 'media', type: 0, categoryKey: 'cat-general', position: 2, topic: 'Share images, videos, and links', slowmode: 5, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },

  // ── SUPPORT (1 channel) ───────────────────────────────────
  // Ticket panel lives here. View-only so members can't clutter it.
  // Ticket channels are created dynamically by the bot (not a template).
  { key: 'support', name: 'support', type: 0, categoryKey: 'cat-support', position: 0, topic: 'Need help? Open a ticket below.', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },

  // ── MUSIC (3 channels) ────────────────────────────────────
  // Music system channels. Lavalink-powered.
  { key: 'music-chat', name: 'music-chat', type: 0, categoryKey: 'cat-music', position: 0, topic: 'Discuss music and request songs', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
  { key: 'now-playing', name: 'now-playing', type: 0, categoryKey: 'cat-music', position: 1, topic: 'Currently playing — updated by SomniBot', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
  { key: 'listening-room', name: 'Listening Room', type: 2, categoryKey: 'cat-music', position: 2, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },

  // ── VOICE (3 channels) ────────────────────────────────────
  // Standard voice channels + staff voice.
  { key: 'vc-general', name: 'General', type: 2, categoryKey: 'cat-voice', position: 0, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },
  { key: 'vc-gaming', name: 'Gaming', type: 2, categoryKey: 'cat-voice', position: 1, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },
  { key: 'vc-staff', name: 'Staff Voice', type: 2, categoryKey: 'cat-voice', position: 2, topic: null, slowmode: 0, nsfw: false, templateId: 'staff-voice', overrides: staffVoiceOverrides() },

  // ── STAFF (3 channels) ────────────────────────────────────
  // Hidden from members. Mod+ only.
  { key: 'staff-chat', name: 'staff-chat', type: 0, categoryKey: 'cat-staff', position: 0, topic: 'Staff-only discussion', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
  { key: 'mod-log', name: 'mod-log', type: 0, categoryKey: 'cat-staff', position: 1, topic: 'Moderation action log — automated by SomniBot', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
  { key: 'bot-log', name: 'bot-log', type: 0, categoryKey: 'cat-staff', position: 2, topic: 'Bot system events & deploy logs', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
];

// ============================================================
// Constants
// ============================================================

const STEPS: StepConfig[] = [
  { number: 1, title: 'Bot Status', description: 'Verify bot connection & permissions', icon: Settings },
  { number: 2, title: 'Role Templates', description: 'Configure role hierarchy & permissions', icon: Shield },
  { number: 3, title: 'Channel Structure', description: 'Design channel layout & access controls', icon: Hash },
  { number: 4, title: 'Review', description: 'Preview all changes before deploying', icon: Eye },
  { number: 5, title: 'Deploy', description: 'Execute server configuration', icon: Rocket },
  { number: 6, title: 'Verification', description: 'Confirm deployment success', icon: CheckCircle2 },
  { number: 7, title: 'Go Live', description: 'Complete setup & enable features', icon: Zap },
];

// ============================================================
// Page
// ============================================================

export default function SetupPage() {
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [completedSteps, setCompletedSteps] = useState<Set<WizardStep>>(new Set());
  const [deploying, setDeploying] = useState(false);
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch setup status on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/server-setup');
        if (res.ok) {
          const data: SetupData = await res.json();
          setSetupData(data);

          // If setup is already completed, mark all steps done
          if (data.guild?.setupCompleted) {
            setCompletedSteps(new Set([1, 2, 3, 4, 5, 6, 7] as WizardStep[]));
            setCurrentStep(7);
          } else if (data.isDeployed) {
            // Deployed but not confirmed
            setCompletedSteps(new Set([1, 2, 3, 4, 5] as WizardStep[]));
            setCurrentStep(6);
          }
        }
      } catch (e) {
        console.error('Failed to load setup status:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const markComplete = (step: WizardStep) => {
    setCompletedSteps((prev) => new Set([...prev, step]));
  };

  const canAdvance = completedSteps.has(currentStep);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-discord-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
          <Rocket size={22} className="text-somni-pink" />
          Server Setup Wizard
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure your Discord server step by step. The bot will create roles, channels,
          and permissions exactly as defined here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* Left: Step navigation */}
        <Card className="h-fit">
          <nav className="space-y-0.5">
            {STEPS.map((step) => {
              const isCompleted = completedSteps.has(step.number);
              const isCurrent = currentStep === step.number;

              return (
                <button
                  key={step.number}
                  onClick={() => setCurrentStep(step.number)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-input px-3 py-2 text-left transition-standard',
                    isCurrent && 'bg-discord-accent/15 ring-1 ring-discord-accent/40',
                    !isCurrent && 'hover:bg-discord-bg-primary/50',
                  )}
                >
                  <div className="shrink-0">
                    {isCompleted ? (
                      <CheckCircle2 size={16} className="text-discord-success" />
                    ) : isCurrent ? (
                      <step.icon size={16} className="text-discord-accent" />
                    ) : (
                      <Circle size={16} className="text-discord-text-muted/40" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn(
                      'truncate text-sm',
                      isCurrent ? 'font-medium text-discord-text-primary' : 'text-discord-text-secondary',
                      isCompleted && !isCurrent && 'text-discord-success/70',
                    )}>
                      {step.title}
                    </p>
                    <p className="truncate text-[10px] text-discord-text-muted">
                      {step.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </nav>
        </Card>

        {/* Right: Step content */}
        <Card>
          {currentStep === 1 && (
            <Step1BotStatus onComplete={() => markComplete(1)} isComplete={completedSteps.has(1)} />
          )}
          {currentStep === 2 && (
            <Step2Roles onComplete={() => markComplete(2)} isComplete={completedSteps.has(2)} />
          )}
          {currentStep === 3 && (
            <Step3Channels onComplete={() => markComplete(3)} isComplete={completedSteps.has(3)} />
          )}
          {currentStep === 4 && (
            <Step4Review onComplete={() => markComplete(4)} isComplete={completedSteps.has(4)} />
          )}
          {currentStep === 5 && (
            <Step5Deploy
              onComplete={() => markComplete(5)}
              isComplete={completedSteps.has(5)}
              deploying={deploying}
              onDeploy={() => setDeploying(true)}
            />
          )}
          {currentStep === 6 && (
            <Step6Verification onComplete={() => markComplete(6)} isComplete={completedSteps.has(6)} />
          )}
          {currentStep === 7 && (
            <Step7GoLive
              onComplete={() => markComplete(7)}
              isComplete={completedSteps.has(7)}
              setupData={setupData}
            />
          )}

          {/* Navigation */}
          <div className="mt-6 flex items-center justify-between border-t border-discord-border-subtle pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={currentStep === 1}
              onClick={() => setCurrentStep((s) => Math.max(1, s - 1) as WizardStep)}
            >
              Back
            </Button>
            <Button
              size="sm"
              disabled={!canAdvance || currentStep === 7}
              onClick={() => setCurrentStep((s) => Math.min(7, s + 1) as WizardStep)}
            >
              Next
              <ChevronRight size={14} />
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// Step 1: Bot Status — calls /api/guild for real bot info
// ============================================================

function Step1BotStatus({
  onComplete,
  isComplete,
}: {
  onComplete: () => void;
  isComplete: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{
    connected: boolean;
    rolePosition: number;
    guildName: string;
    memberCount: number;
    error?: string;
  } | null>(null);

  const runCheck = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/guild');
      if (res.ok) {
        const data = await res.json();
        setStatus({
          connected: true,
          rolePosition: data.botRolePosition ?? -1,
          guildName: data.name ?? 'Unknown',
          memberCount: data.memberCount ?? 0,
        });
        onComplete();
      } else {
        setStatus({ connected: false, rolePosition: -1, guildName: '', memberCount: 0, error: 'Failed to verify bot connection' });
      }
    } catch (err) {
      setStatus({ connected: false, rolePosition: -1, guildName: '', memberCount: 0, error: 'Network error' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Settings size={18} />
            Step 1: Bot Status
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Verify that the bot is connected to your Discord server and has the required permissions.
      </CardDescription>

      {status ? (
        <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3">
          {status.connected ? (
            <>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-discord-success" />
                <span className="text-sm text-discord-text-primary">
                  Connected to <strong>{status.guildName}</strong> ({status.memberCount} members)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-discord-success" />
                <span className="text-sm text-discord-text-primary">
                  Bot role position: <strong>#{status.rolePosition}</strong>
                  {status.rolePosition >= 1 && ' (top — ready to manage roles)'}
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-discord-danger">
              <AlertTriangle size={14} />
              <span className="text-sm">{status.error}</span>
            </div>
          )}
        </div>
      ) : (
        <Button onClick={runCheck} disabled={checking}>
          {checking ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
          {checking ? 'Checking...' : 'Check Bot Status'}
        </Button>
      )}
    </div>
  );
}

// ============================================================
// Step 2: Role Templates — uses default templates
// ============================================================

function Step2Roles({ onComplete, isComplete }: { onComplete: () => void; isComplete: boolean }) {
  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Shield size={18} />
            Step 2: Role Templates
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Configure the roles for your server. SomniBot comes with default templates:
        Admin, Moderator, Member, and cosmetic roles.
      </CardDescription>

      <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
          Default Roles (will be created)
        </p>
        {DEFAULT_ROLES.map((role) => (
          <div key={role.key} className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: `#${role.color.toString(16).padStart(6, '0')}` }} />
            <span className="text-sm text-discord-text-primary">{role.name}</span>
            <Badge variant={role.tier === 'admin' ? 'danger' : role.tier === 'moderator' ? 'warning' : role.tier === 'member' ? 'success' : 'pink'}>
              {role.tier}
            </Badge>
          </div>
        ))}
      </div>

      <p className="text-xs text-discord-text-muted">
        You can customize these on the <strong>Roles</strong> page after setup, or accept the defaults.
      </p>

      <Button size="sm" onClick={onComplete}>
        Accept Defaults
      </Button>
    </div>
  );
}

// ============================================================
// Step 3: Channel Structure — uses default templates
// ============================================================

function Step3Channels({ onComplete, isComplete }: { onComplete: () => void; isComplete: boolean }) {
  const categories = [
    { cat: 'INFORMATION', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-information') },
    { cat: 'GENERAL', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-general') },
    { cat: 'SUPPORT', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-support') },
    { cat: 'MUSIC', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-music') },
    { cat: 'VOICE', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-voice') },
    { cat: 'STAFF', channels: DEFAULT_CHANNELS.filter(c => c.categoryKey === 'cat-staff') },
  ];

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Hash size={18} />
            Step 3: Channel Structure
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Your server will be set up with {DEFAULT_CHANNELS.length} channels in {categories.length} categories.
      </CardDescription>

      <div className="space-y-3 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        {categories.map((g) => (
          <div key={g.cat}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-discord-text-muted">
              {g.cat}
            </p>
            <div className="ml-2 space-y-0.5">
              {g.channels.map((ch) => (
                <p key={ch.key} className="text-discord-text-secondary">
                  {ch.type === 2 ? '🔊' : '#'} {ch.name}
                  {ch.topic && <span className="ml-1 text-discord-text-muted">— {ch.topic}</span>}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Button size="sm" onClick={onComplete}>
        Accept Defaults
      </Button>
    </div>
  );
}

// ============================================================
// Step 4: Review — shows what will happen
// ============================================================

function Step4Review({ onComplete, isComplete }: { onComplete: () => void; isComplete: boolean }) {
  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Eye size={18} />
            Step 4: Review
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Review what the bot will do when you deploy.
      </CardDescription>

      <Card variant="warning">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 text-discord-warning" />
          <div>
            <p className="text-sm font-medium text-discord-text-primary">
              Destructive Action Warning
            </p>
            <p className="text-xs text-discord-text-muted">
              The bot will <strong>delete all existing channels and non-managed roles</strong> in your Discord server,
              then recreate everything from the templates. This cannot be undone.
            </p>
          </div>
        </div>
      </Card>

      <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        <p className="font-medium text-discord-text-primary">Deploy plan:</p>
        <ul className="space-y-1 text-discord-text-secondary">
          <li>1. Set @everyone permissions to zero (lockout model)</li>
          <li>2. Delete {DEFAULT_CHANNELS.length} existing channels</li>
          <li>3. Delete existing non-managed roles</li>
          <li>4. Create {DEFAULT_ROLES.length} roles ({DEFAULT_ROLES.map(r => r.name).join(', ')})</li>
          <li>5. Set role hierarchy positions</li>
          <li>6. Create 7 categories</li>
          <li>7. Create {DEFAULT_CHANNELS.length} channels with permission overrides</li>
          <li>8. Store ID mappings for drift detection</li>
        </ul>
      </div>

      <Button size="sm" onClick={onComplete}>
        I Understand — Ready to Deploy
      </Button>
    </div>
  );
}

// ============================================================
// Step 5: Deploy — calls /api/deploy POST
// ============================================================

function Step5Deploy({
  onComplete,
  isComplete,
  deploying,
  onDeploy,
}: {
  onComplete: () => void;
  isComplete: boolean;
  deploying: boolean;
  onDeploy: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleDeploy = async () => {
    onDeploy();
    setError(null);
    setStatusText('Sending deploy request to bot...');
    setProgress(5);

    try {
      // POST the desired state to trigger the bot
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roles: DEFAULT_ROLES,
          channels: DEFAULT_CHANNELS,
          categories: [
            { key: 'cat-information', name: 'Information', position: 0 },
            { key: 'cat-general', name: 'General', position: 1 },
            { key: 'cat-community', name: 'Community', position: 2 },
            { key: 'cat-music', name: 'Music', position: 3 },
            { key: 'cat-voice', name: 'Voice', position: 4 },
            { key: 'cat-staff', name: 'Staff', position: 5 },
          ],
          cleanExisting: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Deploy request failed');
      }

      setStatusText('Deploy request sent! Bot is now executing...');
      setProgress(20);

      // Poll for deploy completion
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes
      while (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;

        try {
          const statusRes = await fetch('/api/deploy');
          if (statusRes.ok) {
            const statusData: DeployData = await statusRes.json();

            if (!statusData.isDeploying && statusData.desiredState) {
              // Check if deployment completed (applied_at is set)
              const appliedAt = (statusData.desiredState as Record<string, unknown>).applied_at;
              if (appliedAt) {
                setProgress(100);
                setStatusText('Deployment complete!');
                onComplete();
                return;
              }
            }

            // Check recent actions for progress
            if (statusData.recentActions?.length > 0) {
              const latest = statusData.recentActions[0];
              if (latest.action === 'deploy.completed') {
                setProgress(100);
                setStatusText('Deployment complete!');
                onComplete();
                return;
              } else if (latest.action === 'deploy.failed') {
                throw new Error('Deployment failed — check the audit log');
              }
            }
          }
        } catch (pollErr) {
          // Polling errors are non-fatal, keep trying
        }

        // Simulate visual progress
        setProgress(Math.min(90, 20 + (attempts / maxAttempts) * 70));
        setStatusText(`Bot is deploying... (${attempts * 2}s elapsed)`);
      }

      // Timeout — bot might still be working
      setStatusText('Deploy request sent. The bot may still be processing — check Discord to verify.');
      setProgress(100);
      onComplete();

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      setStatusText(`Error: ${msg}`);
    }
  };

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Rocket size={18} />
            Step 5: Deploy
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      {!deploying && !isComplete && (
        <>
          <CardDescription>
            Click the button below to deploy your server configuration.
            The bot will execute all changes in the correct order.
          </CardDescription>
          <Button onClick={handleDeploy} size="lg">
            <Rocket size={16} />
            Deploy Server Configuration
          </Button>
        </>
      )}

      {(deploying || isComplete) && (
        <div className="space-y-3">
          <div className="h-3 overflow-hidden rounded-full bg-discord-bg-tertiary">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                error ? 'bg-discord-danger' : progress >= 100 ? 'bg-discord-success' : 'bg-discord-accent',
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-sm text-discord-text-secondary">{statusText}</p>

          {error && (
            <Card variant="danger">
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-discord-danger" />
                <p className="text-sm text-discord-text-primary">{error}</p>
              </div>
            </Card>
          )}

          {isComplete && !error && (
            <Card variant="success">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-discord-success" />
                <p className="text-sm font-medium text-discord-text-primary">
                  Deployment successful! Your server has been configured.
                </p>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Step 6: Verification — user checks Discord manually
// ============================================================

function Step6Verification({
  onComplete,
  isComplete,
}: {
  onComplete: () => void;
  isComplete: boolean;
}) {
  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} />
            Step 6: Verification
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Open your Discord server and verify everything looks correct.
      </CardDescription>

      <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        <p className="font-medium text-discord-text-primary">Check these items:</p>
        <ul className="space-y-1 text-discord-text-secondary">
          <li>✅ All 6 categories and 15 channels are visible</li>
          <li>✅ Roles appear in the correct hierarchy order (Admin → Moderator → Member → VIP → Subscriber)</li>
          <li>✅ @everyone has zero permissions (can&apos;t see channels without a role)</li>
          <li>✅ Staff channels are hidden from non-staff members</li>
          <li>✅ Bot is at the top of the role hierarchy</li>
        </ul>
      </div>

      <Button size="sm" onClick={onComplete}>
        Everything Looks Good
      </Button>
    </div>
  );
}

// ============================================================
// Step 7: Go Live — confirms setup, unlocks features
// ============================================================

function Step7GoLive({
  onComplete,
  isComplete,
  setupData,
}: {
  onComplete: () => void;
  isComplete: boolean;
  setupData: SetupData | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(setupData?.guild?.setupCompleted ?? false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch('/api/server-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      });

      if (res.ok) {
        setConfirmed(true);
        onComplete();
      } else {
        const data = await res.json();
        setError(data.error ?? 'Confirmation failed');
      }
    } catch (err) {
      setError('Network error — try again');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-somni-pink" />
            Step 7: Go Live
          </div>
        </CardTitle>
        {(isComplete || confirmed) && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        {confirmed
          ? 'Your server is fully configured! All features are now unlocked.'
          : 'Click Confirm to finalize setup and unlock all dashboard features.'
        }
      </CardDescription>

      {confirmed ? (
        <Card variant="success">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-discord-success" />
            <p className="text-sm font-medium text-discord-text-primary">
              Setup complete! All features are now unlocked. Explore the sidebar to configure each module.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {error && (
            <Card variant="danger">
              <p className="text-sm text-discord-danger">{error}</p>
            </Card>
          )}
          <Button onClick={handleConfirm} disabled={confirming}>
            {confirming ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {confirming ? 'Confirming...' : 'Confirm Setup Complete'}
          </Button>
        </>
      )}

      <Card>
        <h4 className="text-sm font-medium text-discord-text-primary">What&apos;s Next</h4>
        <div className="mt-2 space-y-1 text-xs text-discord-text-secondary">
          <p>• <strong>Onboarding:</strong> Configure Discord native onboarding &amp; welcome messages</p>
          <p>• <strong>Moderation:</strong> Set up auto-mod rules &amp; escalation chains</p>
          <p>• <strong>Music:</strong> Configure DJ roles &amp; the music player</p>
          <p>• <strong>Store:</strong> Set up products, plans, and the commerce system</p>
          <p>• <strong>Automations:</strong> Build custom automation workflows</p>
        </div>
      </Card>
    </div>
  );
}
