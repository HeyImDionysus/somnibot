export type GuildConfigPatch = Readonly<Record<string, unknown>>;
export type GuildConfigReadback = Readonly<Record<string, unknown>>;

type SaveGuildConfig = (patch: GuildConfigPatch) => Promise<GuildConfigReadback>;

export type CoordinatedGuildConfigSave =
  | { readonly status: 'confirmed'; readonly config: GuildConfigReadback }
  | { readonly status: 'failed'; readonly config: GuildConfigReadback }
  | { readonly status: 'superseded' };

export class GuildConfigSaveError extends Error {
  constructor(message: string, readonly confirmedConfig?: GuildConfigReadback) {
    super(message);
    this.name = 'GuildConfigSaveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
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

async function readGuildConfig(): Promise<GuildConfigReadback> {
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

export async function saveGuildConfigWithReadback(patch: GuildConfigPatch): Promise<GuildConfigReadback> {
  if (!isJsonValue(patch)) {
    throw new GuildConfigSaveError('The settings change contains a value that cannot be saved.');
  }

  const response = await fetch('/api/guild', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    let confirmedConfig: GuildConfigReadback;
    try {
      confirmedConfig = await readGuildConfig();
    } catch {
      throw new GuildConfigSaveError('The server rejected the settings change.');
    }
    throw new GuildConfigSaveError('The server rejected the settings change.', confirmedConfig);
  }

  return readGuildConfig();
}

export class GuildConfigSaveCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private requestedVersion = 0;
  private publishedVersion = 0;
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
    const request = ++this.requestedVersion;
    const operation = this.queue.then(() => this.saveOperation(patch));
    this.queue = operation.then(() => undefined, () => undefined);

    try {
      const config = await operation;
      this.lastConfirmed = { version: request, config };
      if (request !== this.requestedVersion) await this.waitForQueuedRequests();

      if (this.lastConfirmed.version !== request || request <= this.publishedVersion) {
        return { status: 'superseded' };
      }
      this.publishedVersion = request;
      return { status: 'confirmed', config };
    } catch (error) {
      const config = error instanceof GuildConfigSaveError ? error.confirmedConfig : undefined;
      if (config) {
        this.lastConfirmed = { version: request, config };
        if (request !== this.requestedVersion) await this.waitForQueuedRequests();
        if (this.lastConfirmed.version !== request || request <= this.publishedVersion) {
          return { status: 'superseded' };
        }
        this.publishedVersion = request;
        return { status: 'failed', config };
      }
      if (request !== this.requestedVersion) return { status: 'superseded' };
      throw error;
    }
  }
}
