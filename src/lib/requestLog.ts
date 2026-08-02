import type { Context, MiddlewareHandler } from 'hono';
import { createServiceClient, type Bindings } from './supabase.js';

// Records one row per API request into platform_request_log, which is the raw
// material for the operator console's Traffic screen. Nothing in this system
// recorded requests before this.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE:
//
// 1. It must never slow a request down. The insert happens after the response
//    has been handed back, inside executionCtx.waitUntil().
// 2. It must never fail a request. Every path is wrapped; a logging error is
//    swallowed and logged to the console, never propagated.
// 3. It must never record anything sensitive. Only the matched ROUTE PATTERN
//    is stored (`/api/orders/:id`), never the resolved URL, never the query
//    string, never headers, never a body, never a token, never a raw IP. See
//    QA Test Cases/56-Not-Yet-Implemented-Future-Scope.md, which requires this
//    explicitly of any request-logging that gets added.

interface LogRow {
  ts: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  organization_id: string | null;
  user_id: string | null;
  country: string | null;
  colo: string | null;
}

// Buffered in module scope and flushed in batches. A Workers isolate serves
// many requests, so this turns per-request inserts into roughly one insert per
// BATCH_SIZE requests. Rows buffered in an isolate that gets evicted are lost;
// that is an acceptable trade for analytics data and explicitly not for
// anything else.
const buffer: LogRow[] = [];
const BATCH_SIZE = 25;
const MAX_AGE_MS = 10_000;
let oldestAt = 0;

// /health is excluded so uptime probes don't drown out real traffic in the
// numbers. Everything else, including failures and 429s, is recorded — the
// error rate is the point.
const SKIP_PATHS = new Set(['/health', '/']);

export function requestLogger(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const started = Date.now();
    await next();

    try {
      if (c.req.method === 'OPTIONS') return;
      const path = new URL(c.req.url).pathname;
      if (SKIP_PATHS.has(path)) return;

      // routePath is the pattern Hono matched, and is only populated after
      // next(). Falling back to '(unmatched)' rather than the real path keeps
      // the no-raw-paths guarantee true even for 404s, which are exactly the
      // requests whose URLs are least predictable.
      const route = c.req.routePath && c.req.routePath !== '/*' ? c.req.routePath : '(unmatched)';
      const status = c.res.status;

      // User/org attribution is only recorded for requests that SUCCEEDED,
      // which means a route already verified the bearer token against
      // Supabase. Reading the claim off a failed request would let anyone
      // attribute traffic to any user id by sending a forged token.
      const authenticated = status < 400;

      buffer.push({
        ts: new Date(started).toISOString(),
        method: c.req.method,
        route,
        status,
        duration_ms: Date.now() - started,
        organization_id: authenticated ? uuidOrNull(c.req.header('x-organization-id')) : null,
        user_id: authenticated ? subjectFromJwt(c.req.header('authorization')) : null,
        country: c.req.header('cf-ipcountry') ?? null,
        colo: (c.req.raw as { cf?: { colo?: string } }).cf?.colo ?? null,
      });

      if (oldestAt === 0) oldestAt = started;
      if (buffer.length >= BATCH_SIZE || started - oldestAt >= MAX_AGE_MS) {
        const rows = buffer.splice(0, buffer.length);
        oldestAt = 0;
        c.executionCtx.waitUntil(flush(c, rows));
      }
    } catch (err) {
      console.error('request log middleware error', err);
    }
  };
}

async function flush(c: Context<{ Bindings: Bindings }>, rows: LogRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    const { error } = await createServiceClient(c.env).from('platform_request_log').insert(rows);
    if (error) console.error('request log flush failed', error.message);
  } catch (err) {
    console.error('request log flush threw', err);
  }
}

function uuidOrNull(value: string | undefined): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// Reads the `sub` claim WITHOUT verifying the signature. That is safe here and
// only here: it is used purely to attribute an already-successful request, and
// the request only succeeded because a route verified the same token properly
// via supabase.auth.getUser(). Nothing authorizes off this value.
function subjectFromJwt(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const payload = authHeader.slice(7).trim().split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = (JSON.parse(json) as { sub?: string }).sub;
    return sub ? uuidOrNull(sub) : null;
  } catch {
    return null;
  }
}
