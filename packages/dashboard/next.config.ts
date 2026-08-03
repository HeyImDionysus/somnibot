import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the monorepo root .env before baking browser config.
//
// The browser cannot read process.env, so the login page's Supabase client
// depends entirely on the SOMNIBOT_BUILD_* values inlined below at build time.
// But `next build` only loads .env from THIS package directory, and the
// project keeps its .env at the repo root — so a dashboard built from a normal
// checkout inlined empty strings. Everything then looked fine (pages served,
// server-side auth worked via runtime env) until someone pressed "Sign in with
// Discord", whose client had no Supabase URL and silently did nothing.
//
// Real environment always wins: values already present in process.env (CI,
// hosted platforms, docker) are never overridden by the file.
try {
  const rootEnv = readFileSync(path.join(__dirname, '../../.env'), 'utf8');
  for (const line of rootEnv.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // No root .env (CI, hosted) — the real environment is the source of truth.
}

const nextConfig: NextConfig = {
  // Playwright runs remote-auth and launcher-local servers concurrently. Give
  // each process its own build directory so Linux does not contend on Next's
  // single dev-server lock or overwrite the other server's generated assets.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  env: {
    SOMNIBOT_BUILD_NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    SOMNIBOT_BUILD_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  },
  // Lint runs as a dedicated CI step via `eslint src/`;
  // skip the built-in next lint during `next build` to avoid duplicate / conflicting runs.
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  // Trace dependencies from monorepo root so standalone includes everything
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@somnibot/shared'],
  webpack(config, { dev }) {
    if (!dev) {
      // Production/CI builds should be deterministic and warning-free. Webpack's
      // filesystem cache warns about serializing large strings in this app.
      config.cache = false;
    }
    return config;
  },
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
