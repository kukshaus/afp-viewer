import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2gb',
    },
  },
  // Disable all caching during development
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
        { key: 'Pragma', value: 'no-cache' },
        { key: 'Expires', value: '0' },
      ],
    },
  ],
  webpack: (config, { dev }) => {
    // Disable persistent cache in dev to prevent corruption
    if (dev) {
      config.cache = false;
    }
    return config;
  },
};

export default nextConfig;
