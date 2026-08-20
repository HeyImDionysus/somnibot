'use client';

import { useEffect, useState } from 'react';
import { portalGuildId } from '@/lib/portal-session-storage';

interface PortalBrandData {
  brandName: string;
  poweredBy: boolean;
  logoUrl: string | null;
  headerUrl: string | null;
  backgroundUrl: string | null;
}

let brandRequest: { guild: string; promise: Promise<PortalBrandData | null> } | null = null;

function loadPortalBrand(): Promise<PortalBrandData | null> {
  const guild = portalGuildId();
  if (!guild) return Promise.resolve(null);
  if (brandRequest?.guild !== guild) {
    brandRequest = {
      guild,
      promise: fetch(`/api/portal/branding?guild=${encodeURIComponent(guild)}`)
        .then((response) => response.ok ? response.json() as Promise<PortalBrandData> : null)
        .catch(() => null),
    };
  }
  return brandRequest.promise;
}

function usePortalBrand() {
  const [brand, setBrand] = useState<PortalBrandData | null>(null);
  useEffect(() => { void loadPortalBrand().then(setBrand); }, []);
  return brand;
}

export function PortalBrand() {
  const brand = usePortalBrand();
  return <span className="inline-flex min-w-0 items-center gap-2">{brand?.logoUrl ? <img src={brand.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" /> : null}<span className="min-w-0 break-words">{brand?.brandName ?? 'Customer Portal'}</span>{brand?.poweredBy ? <span className="sr-only"> Powered by SomniBot</span> : null}</span>;
}

export function PortalBrandBackground() {
  const brand = usePortalBrand();
  if (!brand?.backgroundUrl) return null;
  return <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-cover bg-center opacity-15" style={{ backgroundImage: `url(${brand.backgroundUrl})` }} />;
}

export function PortalBrandHeaderImage() {
  const brand = usePortalBrand();
  if (!brand?.headerUrl) return null;
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-20" style={{ backgroundImage: `url(${brand.headerUrl})` }} />;
}
