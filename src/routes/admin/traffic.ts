import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { fetchEdgeAnalytics } from '../../lib/cloudflareAnalytics.js';
import { rangeQuery } from './overview.js';

// Three genuinely different views of "traffic", kept as three routes because
// they measure different things and will legitimately disagree:
//
//   /api/admin/traffic  — what the API actually handled (our own request log)
//   /api/admin/edge     — what Cloudflare saw (includes requests that never
//                         reached the Worker: blocked, cached, rate-limited)
//   /api/admin/site     — the marketing site (page views, referrers, funnel)
//
// Plus /api/admin/usage, which is product usage rather than HTTP volume — DAU
// and orders per day, the "is anyone using this" question.

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/admin/traffic', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_traffic_summary', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(data);
});

app.get('/api/admin/usage', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_usage_series', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(
    ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: r.day,
      activeUsers: Number(r.active_users),
      activeOrgs: Number(r.active_orgs),
      orders: Number(r.orders),
      bookings: Number(r.bookings),
      signups: Number(r.signups),
      newOrgs: Number(r.new_orgs),
    })),
  );
});

app.get('/api/admin/site', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_site_summary', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(data);
});

// The three Workers this project deploys. Names match the `name` field in each
// wrangler.toml — backend/wrangler.toml, frontend/wrangler.toml, and the
// marketing site's. Queried in parallel; each degrades independently, so one
// missing script doesn't blank the whole panel.
const SCRIPTS = ['businessosbackend', 'businessos', 'business-os-web'] as const;

const edgeQuery = rangeQuery.extend({
  script: z.enum(SCRIPTS).optional(),
});

app.get('/api/admin/edge', validate('query', edgeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  const from = q.from ?? new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

  const scripts = q.script ? [q.script] : SCRIPTS;
  const results = await Promise.all(scripts.map((s) => fetchEdgeAnalytics(c.env, s, from, to)));

  return c.json({
    from,
    to,
    // False when CF_API_TOKEN / CF_ACCOUNT_ID aren't set. The console shows a
    // short "how to enable this" note in that case rather than an error.
    configured: results.some((r) => r.configured),
    workers: results,
  });
});

export default app;
