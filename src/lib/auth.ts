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
export async function requireUser(c: HonoContext): Promise<AuthResult | Response> {
  const token = bearerTokenFrom(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Missing bearer token.' }, 401);
  }

  const client = createUserClient(c.env, token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return c.json({ error: 'Invalid or expired session.' }, 401);
  }

  return { client, userId: data.user.id };
}

// Wraps requireUser() with one extra lookup for the caller's organization_id
// — for routes that create org-scoped rows (customers, orders, etc.). Those
// used to trust a client-supplied organizationId parameter, validated only
// by RLS on write; this derives it server-side instead, the same way
// current_organization_id() already does inside Postgres.
export async function requireOrg(c: HonoContext): Promise<OrgAuthResult | Response> {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('profiles')
    .select('organization_id')
    .eq('id', auth.userId)
    .single();

  if (error || !data?.organization_id) {
    return c.json({ error: 'You are not part of an organization.' }, 403);
  }

  return { ...auth, organizationId: data.organization_id as string };
}
