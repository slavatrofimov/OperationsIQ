import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev/build config for the Operations IQ SPA. The Rayfin CLI
// serves the built assets from a public URL after `rayfin up`; locally we run
// `npm run dev` against the live Fabric Eventhouse (read) + Rayfin backend
// (writes). Env is injected from .env / .env.local (VITE_* keys only).
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    // Public source maps expose implementation detail (auth flow, KQL
    // construction, agent tools, error-handling paths), raising recon value for
    // attackers. Off by default for production builds; keep them for the dev
    // server (never published). Opt in with BUILD_SOURCEMAP=true ONLY to upload
    // maps to a *private* error-reporting system -- 'hidden' emits the .map
    // without a sourceMappingURL comment so the shipped bundle never references
    // (and browsers never fetch) it. The CI bundle check rejects published maps.
    sourcemap:
      command === 'serve' ? true : process.env.BUILD_SOURCEMAP === 'true' ? 'hidden' : false,
  },
}));
