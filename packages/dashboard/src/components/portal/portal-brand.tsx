'use client';

import { useEffect, useState } from 'react';
import { portalGuildId } from '@/lib/portal-session-storage';

export function PortalBrand() {
  const [brand, setBrand] = useState<{ brandName: string; poweredBy: boolean } | null>(null);
  useEffect(() => {
    const guild = portalGuildId();
    if (!guild) return;
    fetch(`/api/portal/branding?guild=${encodeURIComponent(guild)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((value) => value && setBrand(value))
      .catch(() => undefined);
  }, []);
  return <>{brand?.brandName ?? 'Customer Portal'}{brand?.poweredBy ? <span className="sr-only"> Powered by SomniBot</span> : null}</>;
}
