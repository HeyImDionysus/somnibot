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
  // NOTE: CSP is set per-request in middleware.ts with a nonce.
  // Only non-CSP security headers are set here statically.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
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
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

