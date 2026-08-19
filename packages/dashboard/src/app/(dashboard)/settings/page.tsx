'use client';

import { AdministrationControls } from '@/components/settings/administration-controls';
import { BotPresenceSettings } from '@/components/settings/bot-presence-settings';
import { ConnectionSettings } from '@/components/settings/connection-settings';
import { DataRetentionSettings } from '@/components/settings/data-retention';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-discord-text-primary">Settings</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure installation connections, owner controls, bot presence, and data retention.
        </p>
      </div>

      <ConnectionSettings />
      <BotPresenceSettings />
      <AdministrationControls />
      <DataRetentionSettings />
    </div>
  );
}
