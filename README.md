# business-os-server

Dedicated backend for business-os-rn — the primary API for the app's
business data (customers, orders, bookings, finance, roles, employees,
notifications, reports). Hono, running on Cloudflare Workers. RLS still
does all real authorization (every route builds a Supabase client scoped
to the caller's own JWT via `requireUser()`/`requireOrg()` in
`src/lib/auth.ts`); this service never reimplements permission logic
itself. See the repo's `ROADMAP.md` for the full build history — this was
originally built on Fastify/Node for Railway, then rewritten for Cloudflare
Workers.
sample

## Local development

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars   # fill in SUPABASE_URL / SUPABASE_ANON_KEY
npm run dev                       # wrangler dev
curl http://localhost:8787/health
```

`SUPABASE_SERVICE_ROLE_KEY` isn't required to run locally yet — nothing
calls `createServiceClient()` until a future route needs it (real employee
invite emails, still deferred).

## Deploying to Cloudflare Workers

```bash
npx wrangler login
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # from Supabase Settings -> API; never commit this value
npx wrangler secret put ALLOWED_ORIGIN              # the deployed frontend's URL
npm run deploy                                      # wrangler deploy
```

Confirm `https://<your-worker>.<subdomain>.workers.dev/health` returns
`{"ok":true}`, then update `frontend/.env`'s `EXPO_PUBLIC_BACKEND_URL` to
that deployed URL.

The rate limiter (`wrangler.toml`'s `[[ratelimits]]` binding) is
edge-distributed by Cloudflare automatically — no separate provisioning
step beyond what's already in `wrangler.toml`, but if `wrangler deploy`
complains about the `namespace_id`, adjust it per whatever Cloudflare's
current tooling expects.

`GET /api/me` requires a real Supabase session access token
(`Authorization: Bearer <token>`) to return anything — test it from the
signed-in app, not from a bare `curl`.
