import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, usingFakeProvider } from './config.js';
import { openDatabase, setDb } from './db/index.js';
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

  app.use(express.json({ limit: '1mb' }));
  app.use(requireUser);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, provider: getProvider().name, fake: usingFakeProvider });
  });

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
  const db = openDatabase(config.databasePath);
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
