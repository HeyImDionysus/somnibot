export interface DashboardActivityEvent {
  type: string;
  action: string;
  description: string;
  timestamp: string;
  success: boolean;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function summarizeReason(details: Record<string, unknown>): string {
  const reason = text(details.reason);
  return reason ? `: ${reason.slice(0, 60)}` : '';
}

function actionLabel(action: string): string {
  return action
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function activityType(action: string): string {
  if (action.startsWith('ticket.')) return action;
  if (action.startsWith('moderation.') || action.startsWith('bot.warn') || action.startsWith('bot.ban') || action.startsWith('bot.kick') || action.startsWith('bot.mute')) {
    return `moderation.${action.split('.').pop()}`;
  }
  if (action.startsWith('commerce.') || action.startsWith('fulfillment.') || action.includes('purchase')) {
    return 'commerce';
  }
  if (action.startsWith('giveaway.')) return action;
  if (action.startsWith('member.')) return action;
  return action.split('.')[0] || 'activity';
}

export function activityDescription(
  action: string,
  details: Record<string, unknown>,
  targetType: string | null,
  targetId: string | null,
): string {
  switch (action) {
    case 'ticket.opened':
      return `New ticket opened${details.ticketNumber ? ` #${details.ticketNumber}` : ''}`;
    case 'ticket.closed':
      return `Ticket closed${details.ticketNumber ? ` #${details.ticketNumber}` : ''}`;
    case 'moderation.warn':
    case 'bot.warn':
      return `Warning issued${summarizeReason(details)}`;
    case 'moderation.ban':
    case 'bot.ban':
      return `Member banned${summarizeReason(details)}`;
    case 'moderation.kick':
    case 'bot.kick':
      return `Member kicked${summarizeReason(details)}`;
    case 'moderation.mute':
    case 'bot.mute':
      return `Member muted${summarizeReason(details)}`;
    case 'fulfillment.one_time_purchase':
    case 'purchase_fulfilled':
      return `Purchase fulfilled: ${text(details.product_name) ?? text(details.productName) ?? 'product'}`;
    case 'fulfillment.subscription_activated':
      return `Subscription activated: ${text(details.product_name) ?? 'plan'}`;
    case 'bot.started':
      return 'Bot started';
    case 'bot.create_role':
      return `Role created: ${text((details.result as Record<string, unknown> | null)?.name) ?? 'role'}`;
    case 'bot.create_channel':
      return `Channel created: ${text((details.result as Record<string, unknown> | null)?.name) ?? 'channel'}`;
    case 'giveaway.ended':
      return `Giveaway ended: ${text(details.prize) ?? 'giveaway'}`;
    case 'giveaway.started':
      return `Giveaway started: ${text(details.prize) ?? 'giveaway'}`;
    default: {
      const label = actionLabel(action);
      const target = targetType
        ? ` · ${targetType}${targetId ? ` ${targetId}` : ''}`
        : '';
      return `${label}${target}`;
    }
  }
}

export function buildActivityEvent(log: Record<string, unknown>): DashboardActivityEvent | null {
  const action = text(log.action);
  const timestamp = text(log.timestamp);
  if (!action || !timestamp || Number.isNaN(Date.parse(timestamp))) return null;

  const details = log.details && typeof log.details === 'object' && !Array.isArray(log.details)
    ? log.details as Record<string, unknown>
    : {};
  return {
    type: activityType(action),
    action,
    description: activityDescription(action, details, null, null),
    timestamp,
    success: log.success !== false,
  };
}
