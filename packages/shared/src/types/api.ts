/**
 * Shared API types for dashboard ↔ Supabase communication.
 */

/** Standard API response envelope */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** Paginated response */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Setup wizard state */
export interface SetupState {
  step: number;
  totalSteps: 7;
  completed: boolean;
  steps: {
    everyone_locked: boolean;
    onboarding_configured: boolean;
    roles_created: boolean;
    channels_created: boolean;
    welcome_configured: boolean;
    permissions_applied: boolean;
    bot_role_verified: boolean;
  };
}

/** Dashboard sidebar nav item */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  href: string;
  locked: boolean;
  lockReason?: string;
  badge?: string;
  children?: NavItem[];
}

/** Guild info from Discord OAuth */
export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features: string[];
}

/** Auth session user */
export interface SessionUser {
  id: string;
  discordId: string;
  username: string;
  avatar: string | null;
  isOwner: boolean;
}
