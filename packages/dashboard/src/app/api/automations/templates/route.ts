/**
 * /api/automations/templates — List and deploy automation templates.
 *
 * GET: List all available templates
 * POST: Deploy a template (creates an automation from a template)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


// ── Templates (inlined to avoid cross-package build dependency) ──

interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
}

const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'welcome_dm',
    name: 'Welcome DM',
    description: 'Send a welcome DM when a member completes onboarding',
    icon: '👋',
    category: 'welcome',
    trigger_type: 'member.verified',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: "Welcome to the server, {user.name}! 🎉 We're glad to have you here. Check out the channels and say hi!" } },
    ],
  },
  {
    id: 'level_role_reward',
    name: 'Level Role Reward',
    description: 'Grant a role when a member reaches a specific level',
    icon: '🏆',
    category: 'engagement',
    trigger_type: 'level.up',
    trigger_config: {},
    conditions: [{ type: 'min_level', config: { value: 10 } }],
    actions: [
      { type: 'give_role', config: { role_id: '' } },
      { type: 'send_message', config: { channel_id: '', message: '🎊 {user} just reached Level {newLevel}! Congrats!' } },
    ],
  },
  {
    id: 'purchase_announcement',
    name: 'Purchase Announcement',
    description: 'Announce a purchase in a channel and DM the buyer',
    icon: '🛒',
    category: 'commerce',
    trigger_type: 'purchase.completed',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_message', config: { channel_id: '', message: '🎉 {user} just purchased {product}! Thank you for your support!' } },
      { type: 'send_dm', config: { message: 'Thanks for your purchase of {product}! Your benefits are now active.' } },
    ],
  },
  {
    id: 'subscription_lapse_warning',
    name: 'Subscription Lapse Warning',
    description: 'DM a warning when a subscription lapses',
    icon: '⚠️',
    category: 'commerce',
    trigger_type: 'subscription.lapsed',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: 'Hey {user.name}, your subscription has lapsed. You have 3 days to renew before access is revoked.' } },
      { type: 'log_to_channel', config: { channel_id: '', message: '⚠️ Subscription lapsed: {user} — {plan}' } },
    ],
  },
  {
    id: 'vip_welcome',
    name: 'VIP Welcome',
    description: 'Post a welcome when someone gains the VIP role',
    icon: '⭐',
    category: 'welcome',
    trigger_type: 'role.gained',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_message', config: { channel_id: '', message: '🌟 Welcome to VIP, {user}! Enjoy your exclusive perks.' } },
    ],
  },
  {
    id: 'content_spotlight',
    name: 'Content Creator Spotlight',
    description: 'Auto-react with ⭐ to messages in a showcase channel',
    icon: '✨',
    category: 'engagement',
    trigger_type: 'message.sent',
    trigger_config: {},
    conditions: [],
    actions: [{ type: 'add_reaction', config: { emoji: '⭐' } }],
  },
  {
    id: 'infraction_log',
    name: 'Infraction Logger',
    description: 'Log infraction details to a staff channel',
    icon: '🔨',
    category: 'moderation',
    trigger_type: 'infraction.created',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'log_to_channel', config: { channel_id: '', message: '🔨 Infraction: {type} for {user} — {reason} (total: {count})' } },
    ],
  },
  {
    id: 'voice_greeting',
    name: 'Voice Channel Greeting',
    description: 'DM a greeting when a user joins a voice channel',
    icon: '🔊',
    category: 'engagement',
    trigger_type: 'voice.joined',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: 'Hey {user.name}! Have a great time in {channel}! 🎧' } },
    ],
  },
];

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  return NextResponse.json({ success: true, data: AUTOMATION_TEMPLATES });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.automation.deployTemplate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { template_id, overrides } = body;

  const template = AUTOMATION_TEMPLATES.find((t) => t.id === template_id);
  if (!template) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 });
  }

  // Merge overrides (e.g., channel_id, role_id) into conditions and actions
  let conditions = template.conditions;
  let actions = template.actions;

  if (overrides) {
    if (overrides.actions && Array.isArray(overrides.actions)) {
      actions = overrides.actions;
    }
    if (overrides.conditions && Array.isArray(overrides.conditions)) {
      conditions = overrides.conditions;
    }
  }

  const { data, error } = await supabase
    .from('automations')
    .insert({
      guild_id: guildId,
      name: overrides?.name ?? template.name,
      description: template.description,
      trigger_type: template.trigger_type,
      trigger_config: template.trigger_config,
      conditions,
      actions,
      enabled: true,
      target_user_ids: overrides?.target_user_ids ?? [],
      target_channel_ids: overrides?.target_channel_ids ?? [],
      exclude_user_ids: overrides?.exclude_user_ids ?? [],
      exclude_channel_ids: overrides?.exclude_channel_ids ?? [],
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
