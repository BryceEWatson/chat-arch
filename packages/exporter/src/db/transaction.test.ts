// Tests for the BEGIN IMMEDIATE retry helper. Covers the happy path
// (commit), the rollback path (any non-busy error), the retry path
// (SQLITE_BUSY backs off and eventually succeeds), and the budget-
// exhaustion path (SQLITE_BUSY persists past maxElapsedMs → throws
// WriterBusyError).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from './connection.js';
import { WriterBusyError, withWriteTransaction } from './transaction.js';

describe('withWriteTransaction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-tx-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits on the happy path and returns the callback value', async () => {
    const db = openDb(join(tmpDir, 'happy.db'));
    try {
      db.exec('CREATE TABLE counters (n INTEGER NOT NULL)');
      db.prepare('INSERT INTO counters (n) VALUES (0)').run();

      const result = await withWriteTransaction(db, (txDb) => {
        txDb.prepare('UPDATE counters SET n = n + 1').run();
        txDb.prepare('UPDATE counters SET n = n + 1').run();
        return 'ok';
      });

      expect(result).toBe('ok');
      const row = db.prepare('SELECT n FROM counters').get() as { n: number };
      expect(row.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('rolls back on non-busy errors and re-throws', async () => {
    const db = openDb(join(tmpDir, 'rollback.db'));
    try {
      db.exec('CREATE TABLE counters (n INTEGER NOT NULL)');
      db.prepare('INSERT INTO counters (n) VALUES (0)').run();

      await expect(
        withWriteTransaction(db, (txDb) => {
          txDb.prepare('UPDATE counters SET n = n + 1').run();
          throw new Error('intentional failure');
        }),
      ).rejects.toThrow('intentional failure');

      // n must still be 0 — the increment inside the failed tx must
      // have rolled back.
      const row = db.prepare('SELECT n FROM counters').get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('retries with exponential backoff on SQLITE_BUSY and eventually succeeds', async () => {
    const db = openDb(join(tmpDir, 'retry.db'));
    try {
      db.exec('CREATE TABLE t (x INTEGER)');

      // Stub out BEGIN IMMEDIATE to fail twice with SQLITE_BUSY, then
      // succeed. We monkey-patch `db.exec` for just the BEGIN strings
      // — the rest of `withWriteTransaction` is exercised normally.
      const realExec = db.exec.bind(db);
      let beginAttempts = 0;
      const sleepDelays: number[] = [];

      type ExecArg = Parameters<typeof realExec>[0];
      (db as { exec: typeof realExec }).exec = (sql: ExecArg) => {
        const sqlText = String(sql);
        if (sqlText.includes('BEGIN IMMEDIATE')) {
          beginAttempts += 1;
          if (beginAttempts <= 2) {
            const err = new Error('database is locked');
            (err as { code?: string }).code = 'SQLITE_BUSY';
            throw err;
          }
        }
        return realExec(sql);
      };

      const result = await withWriteTransaction(
        db,
        (txDb) => {
          txDb.prepare('INSERT INTO t VALUES (?)').run(42);
          return 'committed';
        },
        {
          initialBackoffMs: 10,
          sleep: (ms) => {
            sleepDelays.push(ms);
            return Promise.resolve();
          },
        },
      );

      expect(result).toBe('committed');
      expect(beginAttempts).toBe(3); // 2 busy + 1 success
      // Exponential: 10ms first retry, 20ms second.
      expect(sleepDelays).toEqual([10, 20]);
      const row = db.prepare('SELECT COUNT(*) AS n FROM t').get() as {
        n: number;
      };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('throws WriterBusyError after exhausting the retry budget', async () => {
    const db = openDb(join(tmpDir, 'budget.db'));
    try {
      const realExec = db.exec.bind(db);
      type ExecArg = Parameters<typeof realExec>[0];
      (db as { exec: typeof realExec }).exec = (sql: ExecArg) => {
        if (String(sql).includes('BEGIN IMMEDIATE')) {
          const err = new Error('database is locked');
          (err as { code?: string }).code = 'SQLITE_BUSY';
          throw err;
        }
        return realExec(sql);
      };

      let totalSleep = 0;
      await expect(
        withWriteTransaction(
          db,
          () => {
            throw new Error('should not be called — every BEGIN fails');
          },
          {
            initialBackoffMs: 50,
            maxElapsedMs: 200,
            sleep: (ms) => {
              totalSleep += ms;
              // Simulate time passing so the budget loop terminates.
              return new Promise((resolve) => setTimeout(resolve, ms));
            },
          },
        ),
      ).rejects.toThrow(WriterBusyError);

      // At minimum we slept the initial 50ms before checking budget.
      expect(totalSleep).toBeGreaterThanOrEqual(50);
    } finally {
      db.close();
    }
  });
});
