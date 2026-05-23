import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Lint runs as a dedicated CI step via `eslint src/`;
  // skip the built-in next lint during `next build` to avoid duplicate / conflicting runs.
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  // Trace dependencies from monorepo root so standalone includes everything
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@somnibot/shared'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.discordapp.com',
      },
    ],
  },
  // ── Security Headers ─────────────────────────────────────
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",      // Next.js requires inline scripts
              "style-src 'self' 'unsafe-inline'",                      // Tailwind/CSS-in-JS
              "img-src 'self' data: https://cdn.discordapp.com",       // Discord avatars
              "font-src 'self'",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co", // Supabase API + Realtime
              "frame-ancestors 'none'",                                // Prevent clickjacking
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

