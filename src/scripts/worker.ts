/**
 * Worker entrypoint. ONE process only — see the note at the top of
 * src/queue/worker.ts and "Scaling" in README.md.
 */

import { config } from '../config.js';
import { openDatabase, setDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { startWorker } from '../queue/worker.js';

const db = openDatabase(config.databasePath);
setDb(db);

const handle = startWorker({ provider: getProvider(), intervalMs: 5_000 });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    handle.stop();
    db.close();
    process.exit(0);
  });
}
