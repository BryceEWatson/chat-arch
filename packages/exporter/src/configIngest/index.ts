import type { ConfigDocument } from '@chat-arch/schema';
import { discoverConfigPaths } from './discover.js';
import { parseConfigDocument } from './parse.js';

export interface IngestConfigsOptions {
  globalRoot: string;
  projectRoots: readonly string[];
}

const CONCURRENCY = 8;

export async function ingestConfigs(opts: IngestConfigsOptions): Promise<ConfigDocument[]> {
  const paths = await discoverConfigPaths(opts.globalRoot, opts.projectRoots);
  const results: (ConfigDocument | null)[] = new Array(paths.length).fill(null);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= paths.length) return;
      const p = paths[i];
      if (!p) return;
      try {
        results[i] = await parseConfigDocument(
          p.path,
          p.source,
          p.kind,
          p.projectRoot,
        );
      } catch (err) {
        console.error(`[configIngest] failed to parse ${p.path}:`, err);
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, paths.length) }, () => worker());
  await Promise.all(workers);

  return results.filter((d): d is ConfigDocument => d !== null);
}

export { discoverConfigPaths } from './discover.js';
export { parseConfigDocument } from './parse.js';
