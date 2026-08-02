import type { Bindings } from './supabase.js';

// Cloudflare edge analytics for the three Workers this project deploys
// (businessosbackend, businessos, and the marketing site).
//
// Deliberately NOT stored in Postgres. Cloudflare already retains this data and
// is authoritative for it; copying it into our own tables would only create a
// second number that can disagree with the dashboard the user can also look at.
// The console queries it live and treats it as a separate panel from the
// platform_request_log-derived numbers, which measure something subtly
// different (the edge counts requests that never reached the Worker — blocked,
// cached, or rate-limited at the edge — while our own log counts what the app
// actually handled).
//
// Requires two new secrets. Both are optional: when either is missing this
// module reports `configured: false` rather than throwing, so the Traffic
// screen degrades to the other two tabs instead of erroring.
//   wrangler secret put CF_API_TOKEN     (needs Account Analytics: Read)
//   wrangler secret put CF_ACCOUNT_ID

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

// Cloudflare's Analytics API is slow (multi-second) and rate-limited, and the
// console polls. One in-isolate cache entry per query window is enough to keep
// a dashboard refresh from costing a round trip every time.
const cache = new Map<string, { at: number; data: EdgeAnalytics }>();
const CACHE_TTL_MS = 60_000;

export interface EdgeAnalytics {
  configured: boolean;
  scriptName: string;
  days: { date: string; requests: number; errors: number; subrequests: number }[];
  totals: { requests: number; errors: number; subrequests: number };
  /** Populated when Cloudflare returned an error rather than data. */
  error?: string;
}

const EMPTY = (scriptName: string, error?: string): EdgeAnalytics => ({
  configured: false,
  scriptName,
  days: [],
  totals: { requests: 0, errors: 0, subrequests: 0 },
  error,
});

export async function fetchEdgeAnalytics(
  env: Bindings,
  scriptName: string,
  from: string,
  to: string,
): Promise<EdgeAnalytics> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return EMPTY(scriptName);

  const key = `${scriptName}:${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  // workersInvocationsAdaptive is the dataset behind the Workers dashboard.
  // Grouped by date so the console can draw the same shape as its other two
  // traffic tabs without post-processing.
  const query = `
    query WorkerAnalytics($accountTag: String!, $scriptName: String!, $from: Date!, $to: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 1000
            filter: { scriptName: $scriptName, date_geq: $from, date_leq: $to }
            orderBy: [date_ASC]
          ) {
            dimensions { date }
            sum { requests errors subrequests }
          }
        }
      }
    }`;

  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: env.CF_ACCOUNT_ID, scriptName, from, to },
      }),
    });

    if (!res.ok) return EMPTY(scriptName, `Cloudflare returned ${res.status}`);

    const body = (await res.json()) as {
      errors?: { message: string }[];
      data?: {
        viewer?: {
          accounts?: {
            workersInvocationsAdaptive?: {
              dimensions: { date: string };
              sum: { requests: number; errors: number; subrequests: number };
            }[];
          }[];
        };
      };
    };

    if (body.errors?.length) return EMPTY(scriptName, body.errors[0].message);

    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const days = rows.map((r) => ({
      date: r.dimensions.date,
      requests: r.sum.requests ?? 0,
      errors: r.sum.errors ?? 0,
      subrequests: r.sum.subrequests ?? 0,
    }));

    const data: EdgeAnalytics = {
      configured: true,
      scriptName,
      days,
      totals: days.reduce(
        (acc, d) => ({
          requests: acc.requests + d.requests,
          errors: acc.errors + d.errors,
          subrequests: acc.subrequests + d.subrequests,
        }),
        { requests: 0, errors: 0, subrequests: 0 },
      ),
    };

    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    return EMPTY(scriptName, err instanceof Error ? err.message : 'Cloudflare request failed');
  }
}
