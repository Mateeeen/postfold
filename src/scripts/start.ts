/**
 * Production entrypoint: migrate, then serve.
 *
 * Migrations run in-process on boot rather than as a separate deploy step,
 * because this container is the only writer to the database. A release that
 * started serving before its schema landed would have the worker reading
 * columns that do not exist yet.
 *
 * `numReplicas: 1` in railway.json is load-bearing for the same reason — see
 * README, "Scaling". Two of these against one volume is not a supported
 * configuration.
 */

import { config } from '../config.js';
import { openDatabase, setDb } from '../db/index.js';
import { migrate } from './migrate.js';

const db = openDatabase(config.databasePath);

const applied = migrate(db, 'db');
console.log(
  applied.length === 0
    ? '[start] schema up to date'
    : `[start] applied migrations: ${applied.join(', ')}`,
);

setDb(db);

// Imported only after migrations have run, so nothing touches the database at
// module-evaluation time against an old schema.
await import('../server.js');
