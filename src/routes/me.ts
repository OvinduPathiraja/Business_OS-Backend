import { Hono } from 'hono';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';

const app = new Hono<{ Bindings: Bindings }>();

// Currency formatting/symbol lookup is a frontend display concern
// (src/lib/currency.ts) — the backend only needs the bare fallback code.
const DEFAULT_CURRENCY = 'USD';

interface MembershipRow {
  organization_id: string;
  organization_name: string;
  currency: string;
  role_id: string;
  role_name: string;
  role_is_owner: boolean;
  status: 'active' | 'on_leave' | 'invited';
}

// requireUser, not requireOrg — this route must work for a user with zero
// orgs, or only pending invites, not just an active member.
//
// list_my_memberships() + current_organization_id() replace the old single
// profile+role+org join query — a user can belong to several organizations
// now, so this returns all of them plus which one is currently active,
// keeping the old flat organizationId/organizationName/... fields as a
// convenience mirror of the active membership (every existing frontend call
// site still reads those directly).
app.get('/api/me', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const [profileResult, membershipsResult, activeOrgResult] = await Promise.all([
    auth.client.from('profiles').select('id, full_name').eq('id', auth.userId).single(),
    auth.client.rpc('list_my_memberships'),
    auth.client.rpc('current_organization_id'),
  ]);

  if (profileResult.error) return sendPgError(c, profileResult.error);
  if (membershipsResult.error) return sendPgError(c, membershipsResult.error);
  if (activeOrgResult.error) return sendPgError(c, activeOrgResult.error);

  const memberships = (membershipsResult.data ?? []) as MembershipRow[];
  const activeOrganizationId = (activeOrgResult.data as string | null) ?? null;
  const active = memberships.find((m) => m.organization_id === activeOrganizationId);

  let permissions: string[] = [];
  // The caller's role may point at a custom view (org_views) — an account
  // without dashboard.view gets locked into it by the frontend shell, the
  // generalization of the hardcoded Cashier View (see frontend/App.tsx).
  let view: { id: string; name: string; color: string; config: unknown } | null = null;
  if (active?.role_id) {
    const [permResult, roleViewResult] = await Promise.all([
      auth.client.from('role_permissions').select('permissions(key)').eq('role_id', active.role_id),
      auth.client.from('roles').select('org_views(id, name, color, config)').eq('id', active.role_id).maybeSingle(),
    ]);
    if (permResult.error) return sendPgError(c, permResult.error);
    if (roleViewResult.error) return sendPgError(c, roleViewResult.error);
    permissions = (permResult.data ?? [])
      .map((r: any) => (Array.isArray(r.permissions) ? r.permissions[0]?.key : r.permissions?.key))
      .filter(Boolean);
    const v: any = roleViewResult.data?.org_views;
    const viewRow = Array.isArray(v) ? v[0] : v;
    if (viewRow) view = { id: viewRow.id, name: viewRow.name, color: viewRow.color, config: viewRow.config };
  }

  // Which department (if any) this member belongs to in the active org —
  // drives the Tasks screen's default "my department" scope.
  let departmentId: string | null = null;
  if (activeOrganizationId) {
    const { data: memberRow, error: memberErr } = await auth.client
      .from('organization_members')
      .select('department_id')
      .eq('organization_id', activeOrganizationId)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (memberErr) return sendPgError(c, memberErr);
    departmentId = memberRow?.department_id ?? null;
  }

  return c.json({
    id: profileResult.data.id,
    fullName: profileResult.data.full_name,
    activeOrganizationId,
    memberships: memberships.map((m) => ({
      organizationId: m.organization_id,
      organizationName: m.organization_name,
      currency: m.currency,
      roleName: m.role_name,
      roleIsOwner: m.role_is_owner,
      status: m.status,
    })),
    // Flattened convenience fields mirroring the active membership — kept so
    // every existing single-org call site (frontend/src/auth.tsx's Profile
    // and its ~23 consumers) keeps working unchanged.
    organizationId: activeOrganizationId,
    organizationName: active?.organization_name ?? null,
    currency: active?.currency ?? DEFAULT_CURRENCY,
    roleName: active?.role_name ?? null,
    roleIsOwner: active?.role_is_owner ?? false,
    permissions,
    departmentId,
    view,
  });
});

export default app;
