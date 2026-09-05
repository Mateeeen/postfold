import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, usingFakeProvider } from './config.js';
import { getDb, hasDb, openDatabase, setDb } from './db/index.js';
import { cors, requireAccess } from './http/access.js';
import { requireUser } from './http/auth.js';
import { accountsRouter } from './http/routes/accounts.js';
import { draftsRouter } from './http/routes/drafts.js';
import { postsRouter } from './http/routes/posts.js';
import { queueRouter } from './http/routes/queue.js';
import { suggestionsRouter } from './http/routes/suggestions.js';
import { webhooksRouter } from './http/routes/webhooks.js';
import { getProvider } from './providers/index.js';
import { startWorker } from './queue/worker.js';

export function createApp(): express.Express {
  const app = express();

  // The webhook router mounts its own raw body parser, so it must come before
  // express.json() or the JSON parser will consume the stream and the HMAC
  // will be computed over a re-serialised body that no longer matches.
  app.use(webhooksRouter);

  app.use(cors);
  app.use(express.json({ limit: '1mb' }));

  // Unauthenticated: the platform healthcheck has to reach it, and it exposes
  // nothing beyond liveness.
  app.get('/api/health', (_req, res) => {
    // The commit is reported so "is my deploy live?" is a single call rather
    // than an inference from behaviour. Railway injects these; they are absent
    // locally.
    res.json({
      ok: true,
      provider: getProvider().name,
      fake: usingFakeProvider,
      commit: (process.env['RAILWAY_GIT_COMMIT_SHA'] ?? 'local').slice(0, 7),
      deployedAt: process.env['RAILWAY_DEPLOYMENT_ID'] ? undefined : 'local',
      gated: config.appToken !== null,
    });
  });

  // Everything past this point can act on a real LinkedIn account.
  app.use(requireAccess);
  app.use(requireUser);

  app.use(accountsRouter);
  app.use(postsRouter);
  app.use(suggestionsRouter);
  app.use(queueRouter);
  app.use(draftsRouter);

  // Serve the built frontend if it exists, so `npm run build` in web/ gives a
  // single-origin app. In development Vite proxies to this server instead.
  app.use(express.static(path.resolve('web/dist')));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

function main(): void {
  // Refuse to expose an ungated API. Every route below the gate performs
  // irreversible actions on someone's real account; shipping that open to the
  // internet is not a configuration mistake worth tolerating.
  if (config.isPublic && !config.appToken) {
    console.error(
      'Refusing to start: this deployment is publicly reachable but APP_TOKEN is unset. ' +
        'Set APP_TOKEN to a long random string, or run without a public domain.',
    );
    process.exit(1);
  }

  // start.ts (production) has already opened the database and run migrations.
  // Opening a second handle to the same file would break the single-writer
  // assumption the whole queue rests on.
  const db = hasDb() ? getDb() : openDatabase(config.databasePath);
  setDb(db);

  const app = createApp();

  // One worker. In development it runs in-process so `npm run dev` is the
  // whole product; in production run `npm run worker` as a single separate
  // process instead. Two workers against one SQLite file is unsupported —
  // see README, "Scaling".
  const worker = startWorker({ provider: getProvider(), intervalMs: 5_000 });

  const server = app.listen(config.port, () => {
    console.log(`PostFold on http://localhost:${config.port}`);
    if (usingFakeProvider) {
      console.log('Running on FakeProvider — nothing will be sent to LinkedIn.');
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      worker.stop();
      server.close();
      db.close();
      process.exit(0);
    });
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  main();
}
