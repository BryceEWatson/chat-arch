import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import node from '@astrojs/node';

// `output: 'static'` with a Node adapter enables per-route opt-in to
// server rendering: every page stays static except routes that export
// `prerender = false`. Right now that's only `src/pages/api/rescan.ts`,
// which spawns the local exporter on POST to rescan disk + refresh the
// manifest. The rest (index.astro) builds to a static HTML file —
// deployments that want to drop the dynamic endpoint can remove the
// adapter and the route without touching the UI.
export default defineConfig({
  integrations: [react()],
  output: 'static',
  adapter: node({ mode: 'standalone' }),
});
