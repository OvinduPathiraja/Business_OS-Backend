import type { Context } from 'hono';
import { bearerTokenFrom, createUserClient, type Bindings } from './supabase.js';

export interface AuthResult {
  client: ReturnType<typeof createUserClient>;
  userId: string;
  // Set only when the subscription gate ran (a gated write), which resolves
  // the active organization as a side effect. requireOrg() reuses it instead
  // of asking Postgres the same question twice in one request. Carried on the
  // result rather than through c.set() so no route file has to grow a Hono
  // Variables generic.
  resolvedOrganizationId?: string | null;
}

export interface OrgAuthResult extends AuthResult {
  organizationId: string;
}

type HonoContext = Context<{ Bindings: Bindings }>;

// What my_request_gate() answers — see
// 20260803010000_subscription_access_gate.sql.
interface RequestGate {
  organizationId: string | null;
  isPlatformAdmin: boolean;
  access: 'full' | 'read_only';
  reason: 'trial_expired' | 'past_due' | 'cancelled' | 'suspended' | null;
  graceEndsOn: string | null;
  deviceOk: boolean;
}

// Writes that must keep working for someone whose subscription has lapsed or
// whose device is blocked. Without this list a lapse is a trap: the member of
// a read-only org could not switch to a different org, accept an invite they
// were just sent, leave, or start a fresh workspace — and somebody at their
// device cap could never free a slot.
//
// Matched against c.req.routePath (Hono's matched PATTERN, the same value
// lib/requestLog.ts records) so these are exact routes rather than a fuzzy
// prefix test where a new sibling route silently inherits the exemption.
//
// shared/apiClient.ts keeps a client-side mirror of this list. The two must
// agree; if they drift, the symptom is a button that fails instantly with a
// read-only error the server would actually have allowed.
const WRITE_ALLOWED_PATHS = new Set([
  '/api/organizations',
  '/api/organizations/:id/switch',
  '/api/organizations/:id/accept',
  '/api/organizations/:id/decline',
  '/api/organizations/:id/leave',
  '/api/devices/register',
  '/api/devices/:deviceId/revoke',
  // Ending a "view as" session is cleanup, never a tenant write.
  '/api/impersonate/:id/end',
]);

// Verifies the caller's Supabase JWT and hands back a client scoped to them,
// so every subsequent query is authorized by existing RLS policies rather
// than by anything this server decides on its own. Returns a Response
// directly on failure (Hono has no Fastify-style reply-mutation — callers
// do `const auth = await requireUser(c); if (auth instanceof Response) return auth;`).
//
// Also relays the caller's X-Organization-Id header (if any) into the
// Supabase client — a user can belong to multiple organizations now, and
// this is how the frontend tells the backend/Postgres which one is active
// for this request. It's a hint, not a grant: current_organization_id()
// (the Postgres function every RLS policy resolves "the org" through)
// validates it against real membership and fails closed for anything else.
export async function requireUser(c: HonoContext): Promise<AuthResult | Response> {
  const token = bearerTokenFrom(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Missing bearer token.' }, 401);
  }

  const orgHeader = c.req.header('x-organization-id') || null;
  const client = createUserClient(c.env, token, orgHeader);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return c.json({ error: 'Invalid or expired session.' }, 401);
  }

  // ---------------------------------------------------------------------
  // Subscription + device gate.
  //
  // This lives in requireUser() and not in requireOrg() because requireUser()
  // is the ONLY universal funnel: 87 route handlers call it directly and rely
  // on RLS alone for org scoping, and many of them mutate — PATCH
  // /api/bank-accounts/:id, POST /api/fund-transfers, DELETE /api/bookings,
  // POST /api/invoices/:id/payments. Gating in requireOrg() would leave every
  // one of those writable after a subscription lapsed.
  //
  // It is also not a global middleware, which was the other candidate: that
  // would have to re-parse the bearer token and re-resolve the organization
  // that this function resolves moments later, and would need a hand-kept
  // allowlist of path prefixes where a newly added route file silently
  // inherits whichever behaviour the prefix test happens to fall into.
  //
  // /api/admin/* is exempt without being listed anywhere, because
  // requirePlatformAdmin() builds its own client and never comes through
  // here.
  //
  // Worth being clear about what kind of control this is: unlike org
  // suspension, which bites inside current_organization_id() and therefore in
  // Postgres itself, this is a policy enforced by the Worker. It is correct
  // for every client this product ships, none of which query Supabase
  // directly, but it is strictly weaker than suspension and would not hold
  // against something talking to PostgREST with a raw JWT.
  // ---------------------------------------------------------------------
  const isWrite = c.req.method !== 'GET' && c.req.method !== 'OPTIONS' && c.req.method !== 'HEAD';
  if (!isWrite || c.env.SUBSCRIPTION_GATE !== 'on' || WRITE_ALLOWED_PATHS.has(c.req.routePath)) {
    return { client, userId: data.user.id };
  }

  const { data: gateData, error: gateError } = await client.rpc('my_request_gate', {
    p_device_id: c.req.header('x-device-id') ?? null,
  });

  // Fail OPEN on an RPC error, unlike the rest of this file. A billing check
  // that cannot run is our problem, not the customer's, and the cost of being
  // wrong is asymmetric: wrongly allowing a write loses a little revenue,
  // wrongly blocking one stops a shop from taking money.
  const gate = (gateError ? null : gateData) as RequestGate | null;

  if (gate && !gate.isPlatformAdmin) {
    // Checked before the subscription: a device that was signed out should be
    // told that, not told about billing.
    if (gate.deviceOk === false) {
      return c.json({
        error: 'This device was signed out. Sign in again to continue.',
        code: 'DEVICE_REVOKED',
      }, 403);
    }
    if (gate.access === 'read_only') {
      return c.json({
        error: 'Your subscription has lapsed. You can still open, read and export everything — changes are paused until it is settled.',
        code: 'SUBSCRIPTION_READ_ONLY',
        reason: gate.reason,
      }, 403);
    }
  }

  return { client, userId: data.user.id, resolvedOrganizationId: gate?.organizationId ?? null };
}

// Wraps requireUser() with the caller's resolved active organization — for
// routes that create or scope org-specific rows (customers, orders, etc.).
// Calls the exact same current_organization_id() function RLS itself uses,
// so the backend's idea of "active org" can never drift from Postgres's.
export async function requireOrg(c: HonoContext): Promise<OrgAuthResult | Response> {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  // my_request_gate() already resolved this through the very same
  // current_organization_id() call on the way in, so a gated write costs one
  // round trip in total rather than two.
  if (auth.resolvedOrganizationId) {
    return { ...auth, organizationId: auth.resolvedOrganizationId };
  }

  const { data, error } = await auth.client.rpc('current_organization_id');

  if (error || !data) {
    return c.json({ error: 'You are not part of an organization.' }, 403);
  }

  return { ...auth, organizationId: data as string };
}
