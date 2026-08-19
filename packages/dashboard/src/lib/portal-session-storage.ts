'use client';

const TOKEN_PREFIX = 'portal_token:';
const AUTO_LOGIN_SUPPRESSED_PREFIX = 'portal_auto_login_suppressed:';
const LAST_GUILD_KEY = 'portal_last_guild';
export const PORTAL_TOKEN_CHANGED_EVENT = 'somnibot:portal-token-changed';

function announcePortalTokenChange(): void {
  window.dispatchEvent(new Event(PORTAL_TOKEN_CHANGED_EVENT));
}

export function portalGuildId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('guild');
  if (fromUrl) {
    sessionStorage.setItem('portal_guild', fromUrl);
    localStorage.setItem(LAST_GUILD_KEY, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem('portal_guild') || localStorage.getItem(LAST_GUILD_KEY) || '';
}

export function getPortalToken(guildId = portalGuildId()): string | null {
  return guildId ? localStorage.getItem(`${TOKEN_PREFIX}${guildId}`) : null;
}

export function setPortalToken(guildId: string, token: string): void {
  localStorage.setItem(`${TOKEN_PREFIX}${guildId}`, token);
  sessionStorage.removeItem(`${AUTO_LOGIN_SUPPRESSED_PREFIX}${guildId}`);
  announcePortalTokenChange();
}

export function clearPortalToken(guildId = portalGuildId()): void {
  if (!guildId) return;
  localStorage.removeItem(`${TOKEN_PREFIX}${guildId}`);
  announcePortalTokenChange();
}

export function suppressPortalAutoLogin(guildId = portalGuildId()): void {
  if (guildId) sessionStorage.setItem(`${AUTO_LOGIN_SUPPRESSED_PREFIX}${guildId}`, '1');
}

export function isPortalAutoLoginSuppressed(guildId = portalGuildId()): boolean {
  return Boolean(guildId && sessionStorage.getItem(`${AUTO_LOGIN_SUPPRESSED_PREFIX}${guildId}`));
}

export function allowPortalAutoLogin(guildId = portalGuildId()): void {
  if (guildId) sessionStorage.removeItem(`${AUTO_LOGIN_SUPPRESSED_PREFIX}${guildId}`);
}

export function portalLoginUrl(guildId = portalGuildId()): string {
  return guildId ? `/portal?guild=${encodeURIComponent(guildId)}` : '/portal';
}

export function portalPath(path: string, guildId = portalGuildId()): string {
  return guildId ? `${path}?guild=${encodeURIComponent(guildId)}` : path;
}
