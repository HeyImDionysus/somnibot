'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { portalPath } from '@/lib/portal-session-storage';

export function PortalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [resolvedHref, setResolvedHref] = useState(href);

  useEffect(() => {
    setResolvedHref(portalPath(href));
  }, [href]);

  return <a href={resolvedHref} className={className}>{children}</a>;
}
