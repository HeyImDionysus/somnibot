export type GuildConfigValue = boolean | number | string | null;

export type GuildConfigPatch = Readonly<Record<string, GuildConfigValue>>;
export type GuildConfigReadback = Readonly<Record<string, unknown>>;

type SaveGuildConfig = (patch: GuildConfigPatch) => Promise<GuildConfigReadback>;

export type CoordinatedGuildConfigSave =
  | { readonly status: 'confirmed'; readonly config: GuildConfigReadback }
  | { readonly status: 'superseded' };

export class GuildConfigSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuildConfigSaveError';
  }
}

export class RequestVersionFence {
  private requestedVersion = 0;
  private publishedVersion = 0;

  request(): number {
    this.requestedVersion += 1;
    return this.requestedVersion;
  }

  isLatest(version: number): boolean {
    return version === this.requestedVersion;
  }

  publish(version: number): boolean {
    if (version <= this.publishedVersion) return false;
    this.publishedVersion = version;
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readConfirmedBoolean(config: GuildConfigReadback, key: string): boolean {
  const value = config[key];
  if (typeof value !== 'boolean') throw new GuildConfigSaveError(`The saved ${key} value was missing or invalid.`);
  return value;
}

export function readConfirmedNumber(config: GuildConfigReadback, key: string): number {
  const value = config[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GuildConfigSaveError(`The saved ${key} value was missing or invalid.`);
  }
  return value;
}

export function readConfirmedString(config: GuildConfigReadback, key: string): string {
  const value = config[key];
  if (typeof value !== 'string') throw new GuildConfigSaveError(`The saved ${key} value was missing or invalid.`);
  return value;
}

export async function saveGuildConfigWithReadback(patch: GuildConfigPatch): Promise<GuildConfigReadback> {
  const response = await fetch('/api/guild', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new GuildConfigSaveError('The server rejected the settings change.');

  const readbackResponse = await fetch('/api/guild', { cache: 'no-store' });
  if (!readbackResponse.ok) {
    throw new GuildConfigSaveError('The change was sent, but its saved value could not be confirmed.');
  }

  const body: unknown = await readbackResponse.json();
  if (!isRecord(body) || !isRecord(body.config)) {
    throw new GuildConfigSaveError('The server returned an invalid settings readback.');
  }
  return body.config;
}

export class GuildConfigSaveCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private readonly versions = new RequestVersionFence();
  private lastConfirmed: { readonly version: number; readonly config: GuildConfigReadback } | null = null;

  constructor(private readonly saveOperation: SaveGuildConfig = saveGuildConfigWithReadback) {}

  private async waitForQueuedRequests(): Promise<void> {
    while (true) {
      const tail = this.queue;
      await tail;
      if (tail === this.queue) return;
    }
  }

  async save(patch: GuildConfigPatch): Promise<CoordinatedGuildConfigSave> {
    const request = this.versions.request();
    const operation = this.queue.then(() => this.saveOperation(patch));
    this.queue = operation.then(() => undefined, () => undefined);

    try {
      const config = await operation;
      this.lastConfirmed = { version: request, config };
      if (!this.versions.isLatest(request)) await this.waitForQueuedRequests();

      if (this.lastConfirmed.version !== request || !this.versions.publish(request)) {
        return { status: 'superseded' };
      }
      return { status: 'confirmed', config };
    } catch (error) {
      if (!this.versions.isLatest(request)) return { status: 'superseded' };
      throw error;
    }
  }
}
