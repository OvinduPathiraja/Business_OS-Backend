import type { Context } from 'hono';
import { bearerTokenFrom, createUserClient, createServiceClient, type Bindings } from './supabase.js';

// Platform-operator authorization. This is the gate in front of every
// /api/admin/* route — the routes behind it read across EVERY tenant, so this
// file is the boundary that keeps a normal customer's JWT out of other
// customers' data.
//
// Shape mirrors requireUser/requireOrg in auth.ts (returns a Response on
// failure so callers do `if (auth instanceof Response) return auth;`), but the
// resemblance stops at the shape — the authorization model is different:
//
//   requireOrg  -> "which org is this user acting in", answered by RLS
//   requirePlatformAdmin -> "is this user an operator", answered by an
//                           explicit allowlist, after which RLS is BYPASSED
//
// Two deliberate properties:
//
// 1. The admin check runs through the CALLER'S OWN client, not the
//    service-role one. is_platform_admin() resolves auth.uid() from the JWT
//    Postgres itself verified, so the answer can't be influenced by anything
//    this Worker got wrong about the request.
//
// 2. Only after that check passes does the caller receive `svc`, the
//    service-role client. That key bypasses RLS entirely, so it is never
//    constructed on a path a non-admin can reach.

export type PlatformRole = 'analyst' | 'support' | 'billing' | 'superadmin';

const RANK: Record<PlatformRole, number> = {
  analyst: 1,
  support: 2,
  billing: 3,
  superadmin: 4,
};

export interface PlatformAuthResult {
  /** Service-role client — bypasses RLS. Only ever handed out post-check. */
  svc: ReturnType<typeof createServiceClient>;
  /** The caller's own RLS-bound client, for RPCs that must run as them. */
  client: ReturnType<typeof createUserClient>;
  userId: string;
  role: PlatformRole;
}

type HonoContext = Context<{ Bindings: Bindings }>;

// Every failure returns the SAME 403 and the SAME body — a missing token, a
// valid token for a non-operator, and an operator whose rank is too low are
// indistinguishable from outside. Nothing echoes back the caller's role, the
// required rank, or whether the account exists, so probing these routes tells
// an attacker only that they are not allowed in.
const DENIED = { error: 'Not authorized.', code: 'FORBIDDEN' } as const;

export async function requirePlatformAdmin(
  c: HonoContext,
  minRole: PlatformRole = 'analyst',
): Promise<PlatformAuthResult | Response> {
  const token = bearerTokenFrom(c.req.header('authorization'));
  if (!token) return c.json(DENIED, 403);

  // No X-Organization-Id is forwarded on purpose. An operator acts above
  // organizations; letting a header influence this client would reintroduce
  // exactly the tenant scoping these routes exist to see past.
  const client = createUserClient(c.env, token);

  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) return c.json(DENIED, 403);

  const { data: roleData, error: roleError } = await client.rpc('my_platform_admin_role');
  if (roleError) return c.json(DENIED, 403);

  const role = roleData as PlatformRole | null;
  if (!role || !(role in RANK)) return c.json(DENIED, 403);
  if (RANK[role] < RANK[minRole]) return c.json(DENIED, 403);

  return { svc: createServiceClient(c.env), client, userId: userData.user.id, role };
}

// Audit writer for actions the routes perform directly against the service
// client (the RPCs in the platform_* migrations write their own rows via
// log_platform_action()). Never throws: an audit write failing must not turn a
// completed action into a 500 the operator will retry, producing the action
// twice. It logs loudly instead.
export async function writeAudit(
  auth: PlatformAuthResult,
  c: HonoContext,
  entry: {
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    organizationId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await auth.svc.from('platform_audit_log').insert({
      actor_user_id: auth.userId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      organization_id: entry.organizationId ?? null,
      detail: entry.detail ?? {},
      ip_hash: await hashIp(c),
    });
    if (error) console.error('audit write failed', entry.action, error.message);
  } catch (err) {
    console.error('audit write threw', entry.action, err);
  }
}

// A salted, truncated hash — enough to correlate actions from one origin,
// never enough to recover the address. The salt is the service-role key, which
// is already the most protected value this Worker holds and never leaves it.
export async function hashIp(c: HonoContext): Promise<string | null> {
  const ip = c.req.header('cf-connecting-ip');
  if (!ip) return null;
  return sha256Hex(`${ip}:${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 16);
}

export async function sha256Hex(input: string, bytes = 32): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .slice(0, bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
