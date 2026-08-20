import {
  CreditCard,
  Database,
  MessageSquare,
  Music,
  Server,
  type LucideIcon,
} from 'lucide-react';

export type SettingSource = 'env' | 'db' | 'none';
export type ConnectionStatus = 'connected' | 'disconnected' | 'checking' | 'bot-side';

export interface ConnectionFieldConfig {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  helpText?: string;
}

export interface ConnectionSectionConfig {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
  bootstrapOnly?: boolean;
  fields: ConnectionFieldConfig[];
}

export const CONNECTION_SECTIONS: ConnectionSectionConfig[] = [
  {
    id: 'supabase',
    title: 'Supabase',
    description: 'Database and authentication bootstrap for this dashboard',
    icon: Database,
    iconColor: 'text-emerald-400',
    bootstrapOnly: true,
    fields: [
      { key: 'supabase_url', label: 'Project URL', placeholder: 'https://your-project.supabase.co' },
      { key: 'supabase_anon_key', label: 'Publishable Key', placeholder: 'sb_publishable_...', secret: true },
      {
        key: 'supabase_secret_key',
        label: 'Secret Key',
        placeholder: 'sb_secret_...',
        secret: true,
        helpText: 'Server-side only. Never exposed to the browser.',
      },
    ],
  },
  {
    id: 'discord',
    title: 'Discord',
    description: 'Bot connection, OAuth login, and primary server',
    icon: MessageSquare,
    iconColor: 'text-[#5865F2]',
    fields: [
      { key: 'discord_application_id', label: 'Application ID', placeholder: '1234567890' },
      { key: 'discord_bot_token', label: 'Bot Token', placeholder: 'MTQ3...', secret: true },
      {
        key: 'discord_guild_id',
        label: 'Guild ID',
        placeholder: '1234567890',
        helpText: 'The Discord server this instance manages.',
      },
      {
        key: 'discord_client_secret',
        label: 'OAuth2 Client Secret',
        placeholder: 'AbCdEf...',
        secret: true,
        helpText: 'Used for Discord login on the dashboard.',
      },
    ],
  },
  {
    id: 'paypal',
    title: 'PayPal',
    description: 'Payment processing for the store and commerce features',
    icon: CreditCard,
    iconColor: 'text-[#00457C]',
    fields: [
      { key: 'paypal_client_id', label: 'Client ID', placeholder: 'AfDP...' },
      { key: 'paypal_client_secret', label: 'Client Secret', placeholder: 'EIAf...', secret: true },
      { key: 'paypal_webhook_id', label: 'Webhook ID', placeholder: 'YOUR_PAYPAL_WEBHOOK_ID', secret: true },
      {
        key: 'paypal_webhook_url',
        label: 'Webhook URL',
        placeholder: 'https://your-domain.example/api/paypal/webhook',
        helpText: 'Use <public-callback-base>/api/paypal/webhook.',
      },
      {
        key: 'paypal_sandbox',
        label: 'Sandbox Mode',
        placeholder: 'true or false',
        helpText: 'Use "true" for sandbox testing and "false" for live payments.',
      },
    ],
  },
  {
    id: 'lavalink',
    title: 'Lavalink',
    description: 'Audio streaming connection used by the music system',
    icon: Music,
    iconColor: 'text-[#D770AD]',
    fields: [
      { key: 'lavalink_host', label: 'Host', placeholder: 'localhost' },
      { key: 'lavalink_port', label: 'Port', placeholder: '2333' },
      { key: 'lavalink_password', label: 'Password', placeholder: 'YOUR_LAVALINK_PASSWORD', secret: true },
    ],
  },
  {
    id: 'valkey',
    title: 'Valkey / Redis',
    description: 'Cache connection used for sessions, limits, and durable queues',
    icon: Server,
    iconColor: 'text-red-400',
    fields: [
      { key: 'valkey_url', label: 'Connection URL', placeholder: 'redis://127.0.0.1:6379', secret: true },
    ],
  },
];
