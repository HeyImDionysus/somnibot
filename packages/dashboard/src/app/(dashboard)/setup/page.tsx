'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { Badge } from '@/components/shared/badge';
import { Toggle } from '@/components/shared/input';
import { cn } from '@/lib/utils/cn';
import {
  CheckCircle2, Circle, ChevronRight, Shield, Hash,
  Rocket, Eye, Settings, Users, Zap, AlertTriangle,
  ExternalLink, Copy, Loader2,
} from 'lucide-react';

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

  const markComplete = (step: WizardStep) => {
    setCompletedSteps((prev) => new Set([...prev, step]));
  };

  const canAdvance = completedSteps.has(currentStep);

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
            <Step1BotStatus
              onComplete={() => markComplete(1)}
              isComplete={completedSteps.has(1)}
            />
          )}
          {currentStep === 2 && (
            <Step2Roles
              onComplete={() => markComplete(2)}
              isComplete={completedSteps.has(2)}
            />
          )}
          {currentStep === 3 && (
            <Step3Channels
              onComplete={() => markComplete(3)}
              isComplete={completedSteps.has(3)}
            />
          )}
          {currentStep === 4 && (
            <Step4Review
              onComplete={() => markComplete(4)}
              isComplete={completedSteps.has(4)}
            />
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
            <Step6Verification
              onComplete={() => markComplete(6)}
              isComplete={completedSteps.has(6)}
            />
          )}
          {currentStep === 7 && (
            <Step7GoLive
              onComplete={() => markComplete(7)}
              isComplete={completedSteps.has(7)}
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
// Step Components
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
    rolePosition: string;
    permissions: string[];
    guildName: string;
  } | null>(null);

  const runCheck = async () => {
    setChecking(true);
    // Simulated — in production this calls the API
    await new Promise((r) => setTimeout(r, 1500));
    setStatus({
      connected: true,
      rolePosition: '#1 (highest)',
      permissions: ['Administrator'],
      guildName: 'Test Server',
    });
    setChecking(false);
    onComplete();
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
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-discord-success" />
            <span className="text-sm text-discord-text-primary">
              Connected to <strong>{status.guildName}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-discord-success" />
            <span className="text-sm text-discord-text-primary">
              Bot role at position: <strong>{status.rolePosition}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-discord-success" />
            <span className="text-sm text-discord-text-primary">
              Permissions: {status.permissions.join(', ')}
            </span>
          </div>
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
          Default Roles (pre-configured)
        </p>
        {[
          { name: 'Admin', tier: 'admin', color: '#ED4245' },
          { name: 'Moderator', tier: 'moderator', color: '#FEE75C' },
          { name: 'Member', tier: 'member', color: '#57F287' },
          { name: 'VIP', tier: 'cosmetic', color: '#FF1493' },
          { name: 'Subscriber', tier: 'cosmetic', color: '#00D4FF' },
        ].map((role) => (
          <div key={role.name} className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: role.color }} />
            <span className="text-sm text-discord-text-primary">{role.name}</span>
            <Badge variant={role.tier === 'admin' ? 'danger' : role.tier === 'moderator' ? 'warning' : role.tier === 'member' ? 'success' : 'pink'}>
              {role.tier}
            </Badge>
          </div>
        ))}
      </div>

      <p className="text-xs text-discord-text-muted">
        You can customize these on the <strong>Roles</strong> page, or accept the defaults for now.
      </p>

      <div className="flex gap-2">
        <Button size="sm" onClick={onComplete}>
          Accept Defaults
        </Button>
        <Button size="sm" variant="secondary">
          <ExternalLink size={12} />
          Customize Roles
        </Button>
      </div>
    </div>
  );
}

function Step3Channels({ onComplete, isComplete }: { onComplete: () => void; isComplete: boolean }) {
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
        Define the channels and categories for your server. Default structure includes 6 categories and 15 channels.
      </CardDescription>

      <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        {[
          { cat: 'INFORMATION', channels: ['rules', 'announcements', 'welcome'] },
          { cat: 'GENERAL', channels: ['general', 'media', 'bot-commands'] },
          { cat: 'COMMUNITY', channels: ['lounge'] },
          { cat: 'MUSIC', channels: ['music-chat', 'now-playing', '🔊 Listening Room'] },
          { cat: 'VOICE', channels: ['🔊 General', '🔊 Gaming'] },
          { cat: 'STAFF', channels: ['staff-chat', 'mod-log', 'bot-log'] },
        ].map((g) => (
          <div key={g.cat}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-discord-text-muted">
              {g.cat}
            </p>
            <p className="text-discord-text-secondary">
              {g.channels.map((c) => (c.startsWith('🔊') ? c : `#${c}`)).join(', ')}
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={onComplete}>Accept Defaults</Button>
        <Button size="sm" variant="secondary">
          <ExternalLink size={12} />
          Customize Channels
        </Button>
      </div>
    </div>
  );
}

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
              then recreate everything from the templates defined above. This cannot be undone.
            </p>
          </div>
        </div>
      </Card>

      <div className="space-y-2 rounded-input bg-discord-bg-tertiary/50 p-3 text-sm">
        <p className="font-medium text-discord-text-primary">Deploy plan:</p>
        <ul className="space-y-1 text-discord-text-secondary">
          <li>1. Set @everyone permissions to zero</li>
          <li>2. Delete existing channels and roles</li>
          <li>3. Create 5 roles (Admin → Member tier hierarchy)</li>
          <li>4. Set role hierarchy positions</li>
          <li>5. Create 6 categories</li>
          <li>6. Create 15 channels with permission overrides</li>
          <li>7. Store ID mappings for drift detection</li>
        </ul>
      </div>

      <Button size="sm" onClick={onComplete}>
        I Understand — Ready to Deploy
      </Button>
    </div>
  );
}

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

  const handleDeploy = async () => {
    onDeploy();

    // Simulated progress — in production this reads Realtime updates
    const steps = [
      'Setting @everyone to zero...',
      'Deleting existing channels...',
      'Deleting existing roles...',
      'Creating Admin role...',
      'Creating Moderator role...',
      'Creating Member role...',
      'Setting role positions...',
      'Creating INFORMATION category...',
      'Creating channels...',
      'Applying permission overrides...',
      'Storing ID mappings...',
      'Complete!',
    ];

    for (let i = 0; i < steps.length; i++) {
      setStatusText(steps[i]);
      setProgress(((i + 1) / steps.length) * 100);
      await new Promise((r) => setTimeout(r, 800));
    }

    onComplete();
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
                'h-full rounded-full transition-all duration-300',
                progress >= 100 ? 'bg-discord-success' : 'bg-discord-accent',
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-sm text-discord-text-secondary">{statusText}</p>
          {isComplete && (
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
          <li>✅ All categories and channels are visible</li>
          <li>✅ Roles appear in the correct hierarchy order</li>
          <li>✅ @everyone has zero permissions (can&apos;t see channels without a role)</li>
          <li>✅ Staff channels are hidden from regular members</li>
          <li>✅ Bot is at the top of the role hierarchy</li>
        </ul>
      </div>

      <Button size="sm" onClick={onComplete}>
        Everything Looks Good
      </Button>
    </div>
  );
}

function Step7GoLive({
  onComplete,
  isComplete,
}: {
  onComplete: () => void;
  isComplete: boolean;
}) {
  const [inviteLink, setInviteLink] = useState('');

  return (
    <div className="space-y-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-somni-pink" />
            Step 7: Go Live
          </div>
        </CardTitle>
        {isComplete && <Badge variant="success">Complete</Badge>}
      </CardHeader>

      <CardDescription>
        Your server is configured! Here&apos;s what&apos;s next:
      </CardDescription>

      <div className="space-y-3">
        <Card>
          <h4 className="text-sm font-medium text-discord-text-primary">Admin Invite Link</h4>
          <p className="text-xs text-discord-text-muted">
            Share this link with your admins. They&apos;ll join with Administrator permission.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-1.5 text-xs text-somni-cyan">
              https://discord.gg/your-invite
            </code>
            <Button variant="ghost" size="sm">
              <Copy size={12} />
            </Button>
          </div>
        </Card>

        <Card>
          <h4 className="text-sm font-medium text-discord-text-primary">Next Phases</h4>
          <p className="text-xs text-discord-text-muted">
            Phase 2 setup is complete. The following features will be available in future phases:
          </p>
          <div className="mt-2 space-y-1 text-xs text-discord-text-secondary">
            <p>• <strong>Phase 3:</strong> Server Setup &amp; Deployment automation</p>
            <p>• <strong>Phase 4:</strong> Member Onboarding &amp; Role Assignment</p>
            <p>• <strong>Phase 5:</strong> Sync Engine &amp; Drift Detection (live)</p>
            <p>• <strong>Phase 6:</strong> Music System</p>
          </div>
        </Card>
      </div>

      <Button onClick={onComplete}>
        <Zap size={14} />
        Complete Setup
      </Button>
    </div>
  );
}
