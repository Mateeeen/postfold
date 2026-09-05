# Deploying PostFold

Two hosts, because the two halves have different needs:

| | Where | Why |
| --- | --- | --- |
| API + worker | **Railway** (Docker, 1 replica, volume) | The worker is a continuously running process and SQLite is a single-writer file |
| Frontend | **Vercel** (static Vite build) | It is just a bundle |

> **Do not put the API on Vercel.** Serverless functions die between requests,
> so the queue never drains, drafts never auto-approve and acceptance is never
> polled; and the filesystem is ephemeral, so the database is wiped on every
> cold start. See "Scaling" in README.md.

## 1. Railway — API and worker

1. New project → Deploy from GitHub repo. `railway.json` selects the Dockerfile.
2. **Add a volume**, mounted at `/data`. Without it the database is lost on every
   deploy, taking your account, keywords, drafts and acceptance history with it.
3. Environment variables:

   ```
   APP_TOKEN=<openssl rand -hex 32>
   DATABASE_PATH=/data/postfold.db
   ALLOWED_ORIGINS=https://<your-app>.vercel.app
   UNIPILE_BASE_URL=https://apiXX.unipile.com:1XXXX
   UNIPILE_API_KEY=...
   UNIPILE_WEBHOOK_SECRET=...
   LLM_BASE_URL=https://api.groq.com/openai/v1
   LLM_API_KEY=...
   LLM_MODEL=openai/gpt-oss-120b
   ```

   The server **exits on boot** if it is publicly reachable and `APP_TOKEN` is
   unset. That is deliberate: an open API here can publish posts and send
   connection requests as you.

4. Keep replicas at **1**. Two workers against one queue double-send, which on
   this product means two connection requests to the same person.

Migrations run automatically on boot (`dist/src/scripts/start.js`).

## 2. Vercel — frontend

Root directory `web/`. One environment variable:

```
VITE_API_BASE_URL=https://<your-service>.up.railway.app
```

Then set `ALLOWED_ORIGINS` on Railway to the Vercel URL and redeploy the API.

## 3. First run

The deployed instance has no account. Connect one from your machine, pointed at
the deployed database — or run `npm run connect` locally and copy `data/postfold.db`
onto the volume.

Open the Vercel URL; it will ask for the `APP_TOKEN`, which is stored in
`localStorage` and sent as a bearer token.

## 4. Webhooks

With a stable public URL, point Unipile at `https://<railway-url>/webhooks/unipile`
and create **two** webhooks: *Users → Relations events* (acceptance) and
*Account → Status update* (checkpoints).

## What is still missing before anyone else uses this

`src/http/auth.ts` resolves a **hardcoded user id**. `APP_TOKEN` decides whether
a caller gets in at all; it does not decide *who they are*. One token, one user,
no sessions. Real authentication is required before a second person has access.
