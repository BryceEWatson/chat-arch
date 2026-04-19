import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

/**
 * Extract every file in `zipPath` into `destDir`. Creates `destDir` + any nested
 * directories on demand. Resolves once the entire ZIP has been unpacked (or
 * rejects on the first error).
 *
 * Uses yauzl's streaming API: one entry is processed at a time via
 * `readEntry()` so memory stays bounded regardless of archive size.
 *
 * Guards:
 *   - Directory entries (names ending in `/`) are created, not streamed.
 *   - Absolute or `..`-traversing entry names are rejected (zip-slip).
 *   - Any read stream error rejects the whole operation.
 */
export async function unzipTo(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  return new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error(`yauzl.open returned no zipfile for ${zipPath}`));
        return;
      }

      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      zipfile.on('error', (err) => settle(err));
      zipfile.on('end', () => settle());

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const entryName = entry.fileName;

        // zip-slip guard: reject absolute + traversing paths.
        if (path.isAbsolute(entryName) || entryName.split(/[/\\]/).some((seg) => seg === '..')) {
          settle(new Error(`unsafe zip entry path: ${entryName}`));
          return;
        }

        const destPath = path.join(destDir, entryName);

        // Directory entry — per yauzl docs, fileName ends with '/'.
        if (/\/$/.test(entryName)) {
          mkdir(destPath, { recursive: true }).then(
            () => zipfile.readEntry(),
            (mkErr) => settle(mkErr as Error),
          );
          return;
        }

        // File entry — stream to disk.
        mkdir(path.dirname(destPath), { recursive: true })
          .then(
            () =>
              new Promise<void>((entryResolve, entryReject) => {
                zipfile.openReadStream(entry, (streamErr, readStream) => {
                  if (streamErr || !readStream) {
                    entryReject(streamErr ?? new Error('no read stream'));
                    return;
                  }
                  const out = createWriteStream(destPath);
                  pipeline(readStream as Readable, out).then(
                    () => entryResolve(),
                    (pErr) => entryReject(pErr as Error),
                  );
                });
              }),
          )
          .then(
            () => zipfile.readEntry(),
            (err) => settle(err as Error),
          );
      });

      zipfile.readEntry();
    });
  });
}
