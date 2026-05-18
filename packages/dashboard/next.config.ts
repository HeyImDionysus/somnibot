import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@somnibot/shared'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.discordapp.com',
      },
    ],
  },
};

export default nextConfig;

