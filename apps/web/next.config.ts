import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Web imports ONLY the pure modules from core (types/time) — never db,
  // tools, or agent, which depend on bun:sqlite and belong to the API.
  transpilePackages: ['@mise/core', '@mise/config'],
  // Tauri prod wraps a static export; dev points at this server.
  output: process.env.TAURI_BUILD ? 'export' : undefined,
  // No floating dev badge — it ends up in screenshots and demo recordings.
  devIndicators: false,
};

export default nextConfig;
