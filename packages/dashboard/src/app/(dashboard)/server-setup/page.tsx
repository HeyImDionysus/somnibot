'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { Button } from '@/components/shared/button';
import { Badge } from '@/components/shared/badge';
import { cn } from '@/lib/utils/cn';
import {
  CheckCircle2, Circle, ChevronRight, Shield, Hash,
  Rocket, Eye, Settings, Zap, AlertTriangle,
  Loader2, Plus, Trash2, Crown, Sparkles, Users,
  X,
} from 'lucide-react';
import { deployApi } from '@/lib/api/client';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

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
// Tier Configuration
// ============================================================

type TierKey = 'admin' | 'moderator' | 'member' | 'cosmetic';

const TIER_ORDER: TierKey[] = ['admin', 'moderator', 'member', 'cosmetic'];

const TIER_META: Record<TierKey, {
  label: string;
  description: string;
  badge: 'danger' | 'warning' | 'success' | 'pink';
  icon: typeof Shield;
  defaultColor: number;
}> = {
  admin: {
    label: 'Admin',
    description: 'Full server management — roles, channels, settings. Never grants ADMINISTRATOR.',
    badge: 'danger',
    icon: Crown,
    defaultColor: 0xED4245,
  },
  moderator: {
    label: 'Moderator',
    description: 'Moderation tools — timeout, kick, ban, manage messages/threads.',
    badge: 'warning',
    icon: Shield,
    defaultColor: 0xFEE75C,
  },
  member: {
    label: 'Member',
    description: 'Standard community access — chat, voice, reactions, slash commands.',
    badge: 'success',
    icon: Users,
    defaultColor: 0x57F287,
  },
  cosmetic: {
    label: 'Cosmetic',
    description: 'Display only — name color, hoist. Zero functional permissions.',
    badge: 'pink',
    icon: Sparkles,
    defaultColor: 0xFF69B4,
  },
};

// Permission bitfields from architecture doc §10.1
const PERM = {
  COSMETIC:  '0',
  MEMBER:    '1764069874191937',
  MODERATOR: '1818040596955079',
  ADMIN:     '1829037592805367',
} as const;

const TIER_PERMISSIONS: Record<TierKey, string> = {
  admin: PERM.ADMIN,
  moderator: PERM.MODERATOR,
  member: PERM.MEMBER,
  cosmetic: PERM.COSMETIC,
};

// ============================================================
// Role & Channel Types for the Wizard
// ============================================================

interface WizardRole {
  key: string;
  name: string;
  tier: TierKey;
  permissions: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
}

interface WizardChannel {
  key: string;
  name: string;
  type: number; // 0=text, 2=voice, 5=announcement
  categoryKey: string;
  position: number;
  topic: string | null;
  slowmode: number;
  nsfw: boolean;
  templateId: string;
  overrides: Array<{ roleKey: string; allow: string; deny: string }>;
}

interface WizardCategory {
  key: string;
  name: string;
  position: number;
}

// ============================================================
// Channel Permission Override Helpers
// ============================================================

const CH = {
  VIEW_ONLY_ALLOW: '66624',
  VIEW_ONLY_DENY:  '380104607744',
  VIEW_USE_ALLOW: '1759667428904000',
  STAFF_DENY: '1024',
  STAFF_ALLOW: '19327478848',
  VOICE_ALLOW: '4398083212800',
} as const;

const staffOverrides = () => [
  { roleKey: 'everyone', allow: '0', deny: CH.STAFF_DENY },
  { roleKey: 'moderator', allow: CH.STAFF_ALLOW, deny: '0' },
  { roleKey: 'admin', allow: CH.STAFF_ALLOW, deny: '0' },
];

const viewOnlyOverrides = () => [
  { roleKey: 'member', allow: CH.VIEW_ONLY_ALLOW, deny: CH.VIEW_ONLY_DENY },
];

const viewUseOverrides = () => [
  { roleKey: 'member', allow: CH.VIEW_USE_ALLOW, deny: '0' },
];

const voiceOverrides = () => [
  { roleKey: 'member', allow: CH.VOICE_ALLOW, deny: '0' },
];

const staffVoiceOverrides = () => [
  { roleKey: 'everyone', allow: '0', deny: CH.STAFF_DENY },
  { roleKey: 'moderator', allow: CH.VOICE_ALLOW, deny: '0' },
  { roleKey: 'admin', allow: CH.VOICE_ALLOW, deny: '0' },
];

// ============================================================
// Smart Defaults — no hardcoded role names
// ============================================================

function buildDefaultChannels(): WizardChannel[] {
  return [
    { key: 'rules', name: 'rules', type: 0, categoryKey: 'cat-information', position: 0, topic: 'Server rules and guidelines', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
    { key: 'announcements', name: 'announcements', type: 5, categoryKey: 'cat-information', position: 1, topic: 'Important server announcements', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
    { key: 'welcome', name: 'welcome', type: 0, categoryKey: 'cat-information', position: 2, topic: 'Welcome new members! Introduce yourself here.', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
    { key: 'general', name: 'general', type: 0, categoryKey: 'cat-general', position: 0, topic: 'General discussion', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
    { key: 'off-topic', name: 'off-topic', type: 0, categoryKey: 'cat-general', position: 1, topic: 'Anything goes', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
    { key: 'media', name: 'media', type: 0, categoryKey: 'cat-general', position: 2, topic: 'Share images, videos, and links', slowmode: 5, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
    { key: 'support', name: 'support', type: 0, categoryKey: 'cat-support', position: 0, topic: 'Need help? Open a ticket below.', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
    { key: 'music-chat', name: 'music-chat', type: 0, categoryKey: 'cat-music', position: 0, topic: 'Discuss music and request songs', slowmode: 0, nsfw: false, templateId: 'open', overrides: viewUseOverrides() },
    { key: 'now-playing', name: 'now-playing', type: 0, categoryKey: 'cat-music', position: 1, topic: 'Currently playing — updated by SomniBot', slowmode: 0, nsfw: false, templateId: 'readonly', overrides: viewOnlyOverrides() },
    { key: 'listening-room', name: 'Listening Room', type: 2, categoryKey: 'cat-music', position: 2, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },
    { key: 'vc-general', name: 'General', type: 2, categoryKey: 'cat-voice', position: 0, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },
    { key: 'vc-gaming', name: 'Gaming', type: 2, categoryKey: 'cat-voice', position: 1, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: voiceOverrides() },
    { key: 'vc-staff', name: 'Staff Voice', type: 2, categoryKey: 'cat-voice', position: 2, topic: null, slowmode: 0, nsfw: false, templateId: 'staff-voice', overrides: staffVoiceOverrides() },
    { key: 'staff-chat', name: 'staff-chat', type: 0, categoryKey: 'cat-staff', position: 0, topic: 'Staff-only discussion', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
    { key: 'mod-log', name: 'mod-log', type: 0, categoryKey: 'cat-staff', position: 1, topic: 'Moderation action log — automated by SomniBot', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
    { key: 'bot-log', name: 'bot-log', type: 0, categoryKey: 'cat-staff', position: 2, topic: 'Bot system events & deploy logs', slowmode: 0, nsfw: false, templateId: 'staff', overrides: staffOverrides() },
  ];
}

const DEFAULT_CATEGORIES: WizardCategory[] = [
  { key: 'cat-information', name: 'Information', position: 0 },
  { key: 'cat-general', name: 'General', position: 1 },
  { key: 'cat-support', name: 'Support', position: 2 },
  { key: 'cat-music', name: 'Music', position: 3 },
  { key: 'cat-voice', name: 'Voice', position: 4 },
  { key: 'cat-staff', name: 'Staff', position: 5 },
];

// ============================================================
// Step Configurations
// ============================================================

const STEPS: StepConfig[] = [
  { number: 1, title: 'Bot Status', description: 'Verify bot connection & permissions', icon: Settings },
  { number: 2, title: 'Roles', description: 'Design your role hierarchy by tier', icon: Shield },
  { number: 3, title: 'Channels', description: 'Configure channel structure', icon: Hash },
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
  const { toast } = useToast();
  const [completedSteps, setCompletedSteps] = useState<Set<WizardStep>>(new Set());
  const [deploying, setDeploying] = useState(false);
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [loading, setLoading] = useState(true);

  // Wizard state — roles & channels the user configures
  const [wizardRoles, setWizardRoles] = useState<WizardRole[]>([]);
  const [wizardChannels, setWizardChannels] = useState<WizardChannel[]>(buildDefaultChannels);
  const [wizardCategories, setWizardCategories] = useState<WizardCategory[]>(DEFAULT_CATEGORIES);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/server-setup');
        if (res.ok) {
          const data: SetupData = await res.json();
          setSetupData(data);

          if (data.guild?.setupCompleted) {
            setCompletedSteps(new Set([1, 2, 3, 4, 5, 6, 7] as WizardStep[]));
            setCurrentStep(7);
          } else if (data.isDeployed) {
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
    return <ConfigSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
          <Rocket size={22} className="text-discord-accent" />
          Server Setup Wizard
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Design your Discord server from the dashboard. The bot creates everything in Discord exactly as you configure it here.
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
            <Step2Roles
              onComplete={() => markComplete(2)}
              isComplete={completedSteps.has(2)}
              roles={wizardRoles}
              onRolesChange={setWizardRoles}
            />
          )}
          {currentStep === 3 && (
            <Step3Channels
              onComplete={() => markComplete(3)}
              isComplete={completedSteps.has(3)}
              channels={wizardChannels}
              categories={wizardCategories}
              onChannelsChange={setWizardChannels}
              onCategoriesChange={setWizardCategories}
            />
          )}
          {currentStep === 4 && (
            <Step4Review
              onComplete={() => markComplete(4)}
              isComplete={completedSteps.has(4)}
              roles={wizardRoles}
              channels={wizardChannels}
              categories={wizardCategories}
            />
          )}
          {currentStep === 5 && (
            <Step5Deploy
              onComplete={() => markComplete(5)}
              isComplete={completedSteps.has(5)}
              deploying={deploying}
              onDeploy={() => setDeploying(true)}
              roles={wizardRoles}
              channels={wizardChannels}
              categories={wizardCategories}
            />
          )}
          {currentStep === 6 && (
            <Step6Verification
              onComplete={() => markComplete(6)}
              isComplete={completedSteps.has(6)}
              roles={wizardRoles}
              channels={wizardChannels}
            />
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
// Step 1: Bot Status
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
        const guild = data.guild;
        const rolePosition = guild?.bot_role_position;
        if (!guild?.id || typeof guild.name !== 'string' || typeof rolePosition !== 'number' || rolePosition < 1) {
          setStatus({
            connected: false,
            rolePosition: -1,
            guildName: '',
            memberCount: 0,
            error: 'Bot is connected, but its role is not high enough to deploy server roles',
          });
          return;
        }
        setStatus({
          connected: true,
          rolePosition,
          guildName: guild.name,
          memberCount: data.memberCount ?? 0,
        });
        onComplete();
      } else {
        setStatus({ connected: false, rolePosition: -1, guildName: '', memberCount: 0, error: 'Failed to verify bot connection' });
      }
    } catch {
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
// Step 2: Roles — tier-based role designer (no hardcoded names)
// ============================================================

function Step2Roles({
  onComplete,
  isComplete,
  roles,
  onRolesChange,
}: {
  onComplete: () => void;
  isComplete: boolean;
  roles: WizardRole[];
  onRolesChange: (roles: WizardRole[]) => void;
}) {
  const [addingTier, setAddingTier] = useState<TierKey | null>(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#99AAB5');
  const [newHoist, setNewHoist] = useState(false);

  const addRole = () => {
    if (!addingTier || !newName.trim()) return;

    const tierRoles = roles.filter((r) => r.tier === addingTier);
    const tierIndex = TIER_ORDER.indexOf(addingTier);
    // Position: higher tiers get higher positions
    const basePosition = (TIER_ORDER.length - tierIndex) * 10;
    const position = basePosition + tierRoles.length;

    const key = `${addingTier}-${newName.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const role: WizardRole = {
      key,
      name: newName.trim(),
      tier: addingTier,
      permissions: TIER_PERMISSIONS[addingTier],
      color: parseInt(newColor.replace('#', ''), 16),
      hoist: newHoist,
      mentionable: false,
      position,
    };

    onRolesChange([...roles, role]);
    setNewName('');
    setNewColor('#99AAB5');
    setNewHoist(false);
    setAddingTier(null);
  };

  const removeRole = (key: string) => {
    onRolesChange(roles.filter((r) => r.key !== key));
  };

  const hasRoles = roles.length > 0;

  // Must have at least one role in the member tier to proceed
  const hasMemberRole = roles.some((r) => r.tier === 'member');

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Shield size={18} />
            Step 2: Design Your Roles
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Create roles within each permission tier. Tiers define what permissions a role has —
        you choose the names, colors, and which tier each role belongs to.
        You need at least one <strong>Member</strong> role (granted when users complete onboarding).
      </CardDescription>

      {/* Tier sections */}
      {TIER_ORDER.map((tierKey) => {
        const meta = TIER_META[tierKey];
        const tierRoles = roles.filter((r) => r.tier === tierKey);

        return (
          <div
            key={tierKey}
            className="rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary/30 p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <meta.icon size={16} className={cn(
                  tierKey === 'admin' && 'text-red-400',
                  tierKey === 'moderator' && 'text-yellow-400',
                  tierKey === 'member' && 'text-green-400',
                  tierKey === 'cosmetic' && 'text-pink-400',
                )} />
                <h3 className="text-sm font-medium text-discord-text-primary">
                  {meta.label} Tier
                </h3>
                <Badge variant={meta.badge}>{tierRoles.length} role{tierRoles.length !== 1 ? 's' : ''}</Badge>
              </div>
              <button
                onClick={() => {
                  setAddingTier(addingTier === tierKey ? null : tierKey);
                  setNewName('');
                  setNewColor(`#${meta.defaultColor.toString(16).padStart(6, '0')}`);
                  setNewHoist(tierKey !== 'cosmetic' && tierKey !== 'member');
                }}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-discord-accent hover:bg-discord-accent/10"
              >
                <Plus size={12} />
                Add Role
              </button>
            </div>

            <p className="mt-1 text-xs text-discord-text-muted">{meta.description}</p>

            {/* Existing roles in this tier */}
            {tierRoles.length > 0 && (
              <div className="mt-3 space-y-1">
                {tierRoles.map((role) => (
                  <div
                    key={role.key}
                    className="flex items-center justify-between rounded bg-discord-bg-secondary/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: `#${role.color.toString(16).padStart(6, '0')}` }}
                      />
                      <span className="text-sm text-discord-text-primary">{role.name}</span>
                      {role.hoist && (
                        <span className="text-[10px] text-discord-text-muted">(hoisted)</span>
                      )}
                    </div>
                    <button
                      onClick={() => removeRole(role.key)}
                      className="rounded p-1 text-discord-text-muted hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add role form */}
            {addingTier === tierKey && (
              <div className="mt-3 rounded border border-discord-accent/30 bg-discord-bg-secondary p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs text-discord-text-muted">Role Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={tierKey === 'admin' ? 'e.g. Server Admin' : tierKey === 'moderator' ? 'e.g. Moderator' : tierKey === 'member' ? 'e.g. Verified Member' : 'e.g. Team Red'}
                      className="w-full rounded border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-primary placeholder:text-discord-text-muted/50 focus:border-discord-accent focus:outline-none"
                      onKeyDown={(e) => e.key === 'Enter' && addRole()}
                      autoFocus
                    />
                  </div>
                  <div className="w-20">
                    <label className="mb-1 block text-xs text-discord-text-muted">Color</label>
                    <input
                      type="color"
                      value={newColor}
                      onChange={(e) => setNewColor(e.target.value)}
                      className="h-8 w-full cursor-pointer rounded border border-discord-border-subtle bg-discord-bg-tertiary"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-discord-text-secondary">
                    <input
                      type="checkbox"
                      checked={newHoist}
                      onChange={(e) => setNewHoist(e.target.checked)}
                      className="rounded"
                    />
                    Hoisted
                  </label>
                  <div className="flex gap-1">
                    <Button size="sm" onClick={addRole} disabled={!newName.trim()}>
                      <Plus size={12} />
                      Add
                    </Button>
                    <button
                      onClick={() => setAddingTier(null)}
                      className="rounded p-1.5 text-discord-text-muted hover:bg-discord-bg-tertiary"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Validation & proceed */}
      {!hasMemberRole && hasRoles && (
        <div className="flex items-center gap-2 rounded bg-yellow-500/10 px-3 py-2 text-sm text-yellow-400">
          <AlertTriangle size={14} />
          You need at least one role in the <strong>Member</strong> tier. This role gets granted when users complete onboarding.
        </div>
      )}

      {!hasMemberRole && !hasRoles && (
        <div className="rounded bg-discord-bg-tertiary/50 px-3 py-2 text-xs text-discord-text-muted">
          Click <strong>Add Role</strong> on any tier to start building your hierarchy.
          At minimum, create one Member tier role — it&apos;s what users receive after onboarding.
        </div>
      )}

      <Button
        size="sm"
        onClick={onComplete}
        disabled={!hasMemberRole}
      >
        <CheckCircle2 size={14} />
        Confirm Roles ({roles.length} role{roles.length !== 1 ? 's' : ''})
      </Button>
    </div>
  );
}

// ============================================================
// Step 3: Channel Structure
// ============================================================

function Step3Channels({
  onComplete,
  isComplete,
  channels,
  categories,
  onChannelsChange,
  onCategoriesChange,
}: {
  onComplete: () => void;
  isComplete: boolean;
  channels: WizardChannel[];
  categories: WizardCategory[];
  onChannelsChange: (ch: WizardChannel[]) => void;
  onCategoriesChange: (cat: WizardCategory[]) => void;
}) {
  const grouped = categories.map((cat) => ({
    ...cat,
    channels: channels.filter((ch) => ch.categoryKey === cat.key),
  }));

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
        Your server will be set up with {channels.length} channels in {categories.length} categories.
        You can add, remove, or rename channels after setup from the Channels page.
      </CardDescription>

      <div className="space-y-3 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        {grouped.map((g) => (
          <div key={g.key}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-discord-text-muted">
              {g.name}
            </p>
            <div className="ml-2 space-y-0.5">
              {g.channels.map((ch) => (
                <p key={ch.key} className="text-discord-text-secondary">
                  {ch.type === 2 ? '🔊' : ch.type === 5 ? '📢' : '#'} {ch.name}
                  {ch.topic && <span className="ml-1 text-discord-text-muted">— {ch.topic}</span>}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Button size="sm" onClick={onComplete}>
        <CheckCircle2 size={14} />
        Confirm Channels
      </Button>
    </div>
  );
}

// ============================================================
// Step 4: Review — dynamic based on user's choices
// ============================================================

function Step4Review({
  onComplete,
  isComplete,
  roles,
  channels,
  categories,
}: {
  onComplete: () => void;
  isComplete: boolean;
  roles: WizardRole[];
  channels: WizardChannel[];
  categories: WizardCategory[];
}) {
  const rolesByTier = TIER_ORDER.map((tier) => ({
    tier,
    label: TIER_META[tier].label,
    roles: roles.filter((r) => r.tier === tier),
  })).filter((g) => g.roles.length > 0);

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
        Review what the bot will create in your Discord server.
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
              then recreate everything from your configuration. This cannot be undone.
            </p>
          </div>
        </div>
      </Card>

      <div className="space-y-3 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        <p className="font-medium text-discord-text-primary">Deploy plan:</p>
        <ul className="space-y-1 text-discord-text-secondary">
          <li>1. Set @everyone permissions to zero (lockout model)</li>
          <li>2. Delete existing non-managed roles and channels</li>
          <li>3. Create {roles.length} roles:</li>
        </ul>

        {/* Role hierarchy preview */}
        <div className="ml-4 space-y-2 rounded border border-discord-border-subtle/50 bg-discord-bg-secondary/30 p-2">
          <div className="flex items-center gap-2 text-xs text-discord-text-muted">
            <span className="font-medium">🤖 SomniBot</span>
            <span className="text-[10px]">(locked — top of hierarchy)</span>
          </div>
          {rolesByTier.map((group) => (
            <div key={group.tier} className="space-y-0.5">
              {group.roles.map((role) => (
                <div key={role.key} className="flex items-center gap-2 text-xs">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: `#${role.color.toString(16).padStart(6, '0')}` }}
                  />
                  <span className="text-discord-text-primary">{role.name}</span>
                  <Badge variant={TIER_META[group.tier].badge}>
                    {group.label}
                  </Badge>
                </div>
              ))}
            </div>
          ))}
          <div className="flex items-center gap-2 text-xs text-discord-text-muted">
            <span className="font-medium">@everyone</span>
            <span className="text-[10px]">(zero permissions)</span>
          </div>
        </div>

        <ul className="space-y-1 text-discord-text-secondary">
          <li>4. Create {categories.length} categories</li>
          <li>5. Create {channels.length} channels with permission overrides</li>
          <li>6. Store ID mappings for drift detection</li>
        </ul>
      </div>

      <Button size="sm" onClick={onComplete}>
        I Understand — Ready to Deploy
      </Button>
    </div>
  );
}

// ============================================================
// Step 5: Deploy — sends user's configured roles/channels
// ============================================================

function Step5Deploy({
  onComplete,
  isComplete,
  deploying,
  onDeploy,
  roles,
  channels,
  categories,
}: {
  onComplete: () => void;
  isComplete: boolean;
  deploying: boolean;
  onDeploy: () => void;
  roles: WizardRole[];
  channels: WizardChannel[];
  categories: WizardCategory[];
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
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roles,
          channels,
          categories,
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
      const maxAttempts = 60;
      while (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;

        try {
          const statusRes = await fetch('/api/deploy');
          if (statusRes.ok) {
            const statusData: DeployData = await statusRes.json();

            if (!statusData.isDeploying && statusData.desiredState) {
              const appliedAt = (statusData.desiredState as Record<string, unknown>).applied_at;
              if (appliedAt) {
                setProgress(100);
                setStatusText('Deployment complete!');
                onComplete();
                return;
              }
            }

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

        setProgress(Math.min(90, 20 + (attempts / maxAttempts) * 70));
        setStatusText(`Bot is deploying... (${attempts * 2}s elapsed)`);
      }

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
            The bot will create {roles.length} roles and {channels.length} channels.
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
// Step 6: Verification — dynamic based on actual config
// ============================================================

function Step6Verification({
  onComplete,
  isComplete,
  roles,
  channels,
}: {
  onComplete: () => void;
  isComplete: boolean;
  roles: WizardRole[];
  channels: WizardChannel[];
}) {
  const categoryCount = new Set(channels.map((ch) => ch.categoryKey)).size;
  const tierSummary = TIER_ORDER
    .map((t) => {
      const count = roles.filter((r) => r.tier === t).length;
      return count > 0 ? `${count} ${TIER_META[t].label}` : null;
    })
    .filter(Boolean)
    .join(', ');

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
          <li>✅ {categoryCount} categories and {channels.length} channels are visible</li>
          <li>✅ Roles appear in the correct hierarchy ({tierSummary})</li>
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
  const { toast } = useToast();

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
      toast({ title: data.error ?? 'Confirmation failed', variant: 'error' });
      }
    } catch {
      setError('Network error — try again');
      toast({ title: 'Network error — try again', variant: 'error' });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-discord-accent" />
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
          <p>• <strong>Roles:</strong> Fine-tune permissions per role from the Roles page</p>
          <p>• <strong>Channels:</strong> Add or reorganize channels from the Channels page</p>
          <p>• <strong>Onboarding:</strong> Configure Discord native onboarding &amp; welcome messages</p>
          <p>• <strong>Moderation:</strong> Set up auto-mod rules &amp; escalation chains</p>
          <p>• <strong>Music:</strong> Configure the music player &amp; DJ permissions</p>
          <p>• <strong>Store:</strong> Set up products, plans, and the commerce system</p>
          <p>• <strong>Automations:</strong> Build custom automation workflows</p>
        </div>
      </Card>
    </div>
  );
}
