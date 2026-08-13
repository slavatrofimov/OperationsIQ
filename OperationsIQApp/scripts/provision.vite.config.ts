/**
 * Vite config used ONLY to run the agent provisioning script in Node
 * (`vite-node --config scripts/provision.vite.config.ts ...`).
 *
 * The tool registry (`src/lib/agent/registry.ts`) transitively imports
 * browser-only modules — the MSAL wrapper (instantiates a browser client at
 * import), the Rayfin GraphQL client, and `echarts` (canvas). Provisioning only
 * needs each tool's schema metadata and never calls `run()`, so we resolve those
 * leaf modules to lightweight stubs. This mirrors the module mocks that
 * `registryTools.test.ts` uses to load the same registry under Node.
 */
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const stub = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Redirect specific browser-only leaf modules to Node-safe stubs. */
function stubBrowserLeaves(): Plugin {
  const byBasename: Record<string, string> = {
    msal: stub('./stubs/msal.ts'),
    rayfinClient: stub('./stubs/rayfinClient.ts'),
  };
  return {
    name: 'stub-browser-leaves',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'echarts') return stub('./stubs/echarts.ts');
      // Match `../msal`, `./lib/msal`, `../rayfinClient`, etc. by basename.
      const base = source.replace(/\.(ts|js|mjs)$/, '').split('/').pop() ?? '';
      return byBasename[base] ?? null;
    },
  };
}

export default defineConfig({
  plugins: [stubBrowserLeaves()],
});
