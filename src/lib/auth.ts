import type { Context } from 'hono';
import { bearerTokenFrom, createUserClient, type Bindings } from './supabase.js';

export interface AuthResult {
  client: ReturnType<typeof createUserClient>;
  userId: string;
}

export interface OrgAuthResult extends AuthResult {
  organizationId: string;
}

type HonoContext = Context<{ Bindings: Bindings }>;

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

  return { client, userId: data.user.id };
}

// Wraps requireUser() with the caller's resolved active organization — for
// routes that create or scope org-specific rows (customers, orders, etc.).
// Calls the exact same current_organization_id() function RLS itself uses,
// so the backend's idea of "active org" can never drift from Postgres's.
export async function requireOrg(c: HonoContext): Promise<OrgAuthResult | Response> {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('current_organization_id');

  if (error || !data) {
    return c.json({ error: 'You are not part of an organization.' }, 403);
  }

  return { ...auth, organizationId: data as string };
}
