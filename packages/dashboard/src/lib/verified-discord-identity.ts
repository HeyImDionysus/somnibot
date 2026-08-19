import type { User } from '@supabase/supabase-js';

export function verifiedDiscordId(user: User): string | null {
  const discordIdentity = user.identities?.find((identity) => identity.provider === 'discord');
  const identityData = discordIdentity?.identity_data;
  if (identityData && typeof identityData === 'object') {
    const data: Record<string, unknown> = identityData;
    const providerSubject = data.sub ?? data.provider_id;
    if (typeof providerSubject === 'string' && providerSubject.length > 0) return providerSubject;
  }
  if (discordIdentity?.id) return discordIdentity.id;
  const serverAssignedId = user.app_metadata?.discord_id;
  return typeof serverAssignedId === 'string' && serverAssignedId.length > 0
    ? serverAssignedId
    : null;
}
