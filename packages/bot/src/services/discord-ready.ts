import { Events } from 'discord.js';

export interface DiscordReadyClient {
  isReady(): boolean;
  once(event: Events.ClientReady, listener: () => void): unknown;
}

export function initializeWhenDiscordReady(
  client: DiscordReadyClient,
  initialize: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const run = () => {
    void initialize().catch(onError);
  };

  if (client.isReady()) {
    run();
    return;
  }

  client.once(Events.ClientReady, run);
}
