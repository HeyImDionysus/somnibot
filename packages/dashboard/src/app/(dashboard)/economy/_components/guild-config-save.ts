type GuildConfigValue = boolean | number | string | null;

type GuildConfigPatch = Readonly<Record<string, GuildConfigValue>>;

export class GuildConfigSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuildConfigSaveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function saveGuildConfigWithReadback(patch: GuildConfigPatch): Promise<void> {
  const response = await fetch('/api/guild', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new GuildConfigSaveError('The server rejected the settings change.');
  }

  const readbackResponse = await fetch('/api/guild', { cache: 'no-store' });
  if (!readbackResponse.ok) {
    throw new GuildConfigSaveError('The change was sent, but its saved value could not be confirmed.');
  }

  const body: unknown = await readbackResponse.json();
  if (!isRecord(body) || !isRecord(body.config)) {
    throw new GuildConfigSaveError('The server returned an invalid settings readback.');
  }

  for (const [key, expected] of Object.entries(patch)) {
    if (body.config[key] !== expected) {
      throw new GuildConfigSaveError(`The saved ${key} value did not match the requested value.`);
    }
  }
}
