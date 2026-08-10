function configuredPublicOrigin(): URL | null {
  const raw = process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function headerHostMatches(value: string | null, configured: URL): boolean {
  if (!value) return false;

  const host = value.split(',', 1)[0].trim().toLowerCase();
  return host === configured.host.toLowerCase();
}

export function getTrustedRedirectOrigin(request: Request): string {
  const configured = configuredPublicOrigin();
  if (
    configured
    && (
      headerHostMatches(request.headers.get('host'), configured)
      || headerHostMatches(request.headers.get('x-forwarded-host'), configured)
    )
  ) {
    return configured.origin;
  }

  return new URL(request.url).origin;
}

export function getTrustedRedirectUrl(request: Request): URL {
  const target = new URL(request.url);
  const origin = getTrustedRedirectOrigin(request);
  if (origin === target.origin) return target;

  const publicOrigin = new URL(origin);
  target.protocol = publicOrigin.protocol;
  target.hostname = publicOrigin.hostname;
  target.port = publicOrigin.port;
  return target;
}
