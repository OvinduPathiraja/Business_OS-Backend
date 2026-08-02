import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';

// Every user across every tenant, plus management of the operator allowlist
// itself. Reads here use the service client throughout: profiles, roles and
// organization_members are all TENANT tables whose RLS scopes them to a single
// organization, which is precisely the scoping this screen exists to see past.

const app = new Hono<{ Bindings: Bindings }>();

const usersQuery = z.object({
  search: z.string().trim().max(200).optional(),
  organizationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

app.get('/api/admin/users', validate('query', usersQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');

  // Scoping by org is a membership lookup first, then a profile fetch — going
  // the other way (filter profiles by an embedded membership) can't express
  // "only members of THIS org" in PostgREST without dropping to a view.
  let userIdFilter: string[] | null = null;
  if (q.organizationId) {
    const { data, error } = await auth.svc
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', q.organizationId);
    if (error) return sendPgError(c, error);
    userIdFilter = (data ?? []).map((m: Record<string, unknown>) => m.user_id as string);
    if (!userIdFilter.length) return c.json({ total: 0, users: [] });
  }

  let query = auth.svc
    .from('profiles')
    .select('id, full_name, email, created_at, last_active_organization_id', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.search) query = query.or(`full_name.ilike.%${q.search}%,email.ilike.%${q.search}%`);
  if (userIdFilter) query = query.in('id', userIdFilter);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);

  const ids = (data ?? []).map((p: Record<string, unknown>) => p.id as string);
  const [membershipsRes, adminsRes] = await Promise.all([
    ids.length
      ? auth.svc
          .from('organization_members')
          .select('user_id, status, organization_id, organizations(name), roles(name, is_owner)')
          .in('user_id', ids)
      : Promise.resolve({ data: [], error: null }),
    auth.svc.from('platform_admins').select('user_id, role, disabled_at'),
  ]);
  if (membershipsRes.error) return sendPgError(c, membershipsRes.error);
  if (adminsRes.error) return sendPgError(c, adminsRes.error);

  const byUser = new Map<string, Record<string, unknown>[]>();
  for (const m of (membershipsRes.data ?? []) as Record<string, unknown>[]) {
    const list = byUser.get(m.user_id as string) ?? [];
    list.push(m);
    byUser.set(m.user_id as string, list);
  }
  const adminByUser = new Map(
    ((adminsRes.data ?? []) as Record<string, unknown>[]).map((a) => [a.user_id as string, a]),
  );

  return c.json({
    total: count ?? 0,
    users: (data ?? []).map((p: Record<string, unknown>) => {
      const admin = adminByUser.get(p.id as string);
      return {
        id: p.id,
        fullName: p.full_name,
        email: p.email,
        createdAt: p.created_at,
        lastActiveOrganizationId: p.last_active_organization_id,
        platformRole: admin && !admin.disabled_at ? admin.role : null,
        memberships: (byUser.get(p.id as string) ?? []).map((m) => {
          const org = m.organizations as { name?: string } | null;
          const role = m.roles as { name?: string; is_owner?: boolean } | null;
          return {
            organizationId: m.organization_id,
            organizationName: org?.name ?? null,
            roleName: role?.name ?? null,
            isOwner: role?.is_owner ?? false,
            status: m.status,
          };
        }),
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// The operator allowlist. superadmin only — this is the route that decides who
// else can see every tenant's data.
// ---------------------------------------------------------------------------
app.get('/api/admin/platform-admins', async (c) => {
  const auth = await requirePlatformAdmin(c, 'superadmin');
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.svc
    .from('platform_admins')
    .select('user_id, role, note, created_at, disabled_at, profiles!platform_admins_user_id_fkey(full_name, email)')
    .order('created_at', { ascending: true });
  if (error) return sendPgError(c, error);

  return c.json(
    (data ?? []).map((a: Record<string, unknown>) => {
      const p = a.profiles as { full_name?: string; email?: string } | null;
      return {
        userId: a.user_id,
        fullName: p?.full_name ?? null,
        email: p?.email ?? null,
        role: a.role,
        note: a.note,
        createdAt: a.created_at,
        disabledAt: a.disabled_at,
      };
    }),
  );
});

const adminBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(['analyst', 'support', 'billing', 'superadmin']).optional(),
  disabled: z.boolean().optional().default(false),
  note: z.string().trim().max(500).optional(),
});

app.put('/api/admin/platform-admins', validate('json', adminBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'superadmin');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  // manage_platform_admin() also refuses self-modification — the check lives in
  // the RPC rather than here so it holds no matter what calls it.
  const { error } = await auth.client.rpc('manage_platform_admin', {
    p_user_id: b.userId,
    p_role: b.role ?? null,
    p_disabled: b.disabled,
    p_note: b.note ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json({ ok: true });
});

export default app;
