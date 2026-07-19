import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../lib/supabase.js';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';
import { sendInviteEmail } from '../lib/email.js';

const inviteBody = z.object({
  fullName: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  roleId: z.string().uuid(),
  branchIds: z.array(z.string().uuid()).optional(),
});

const updateBody = z.object({
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['active', 'on_leave']).optional(),
  branchIds: z.array(z.string().uuid()).optional(),
});

// A user can belong to several organizations now, so "employee" rows live on
// organization_members, not profiles — profiles!user_id disambiguates the
// embed since organization_members has two FKs into profiles (user_id and
// invited_by).
const MEMBER_SELECT = 'user_id, phone, department, role_id, status, created_at, roles(name), profiles!user_id(full_name, email)';
const INVITE_SELECT = 'id, full_name, email, phone, department, role_id, status, invited_at, roles(name)';

function roleNameFrom(row: any) {
  const roles = row.roles as { name: string } | { name: string }[] | null;
  return Array.isArray(roles) ? roles[0]?.name ?? null : roles?.name ?? null;
}

function profileFrom(row: any) {
  const p = row.profiles as { full_name: string; email: string } | { full_name: string; email: string }[] | null;
  return Array.isArray(p) ? p[0] : p;
}

// Empty array = unrestricted (access to every branch in the org) — see the
// schema comment in supabase/migrations/20260719140000_employee_branch_access.sql
// for why "zero rows" was chosen as the default instead of an explicit
// "all branches" flag.
function memberFromRow(row: any, branchIds: string[]) {
  const profile = profileFrom(row);
  return {
    id: row.user_id, kind: 'member', fullName: profile?.full_name ?? '(no name)', email: profile?.email ?? null,
    phone: row.phone, department: row.department, roleId: row.role_id, roleName: roleNameFrom(row),
    status: row.status, createdAt: row.created_at, branchIds,
  };
}
function inviteFromRow(row: any, branchIds: string[]) {
  return {
    id: row.id, kind: 'invited', fullName: row.full_name, email: row.email,
    phone: row.phone, department: row.department, roleId: row.role_id, roleName: roleNameFrom(row),
    status: 'invited', createdAt: row.invited_at, branchIds,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// requireOrg (not requireUser) + an explicit organization_id filter — unlike
// the old single-org model, organization_members' self-view RLS policy is
// deliberately NOT org-scoped (a multi-org switcher needs to see every org a
// user belongs to), so an unfiltered select here would return this caller's
// rows across every org they're in, not just the active one.
app.get('/api/employees', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const [members, invites, memberBranches, inviteBranches] = await Promise.all([
    auth.client
      .from('organization_members')
      .select(MEMBER_SELECT)
      .eq('organization_id', auth.organizationId)
      .order('created_at', { ascending: false }),
    auth.client.from('employee_invites').select(INVITE_SELECT).order('invited_at', { ascending: false }),
    auth.client.from('organization_member_branches').select('user_id, branch_id').eq('organization_id', auth.organizationId),
    auth.client.from('employee_invite_branches').select('invite_id, branch_id'),
  ]);
  if (members.error) return sendPgError(c, members.error);
  if (invites.error) return sendPgError(c, invites.error);
  if (memberBranches.error) return sendPgError(c, memberBranches.error);
  if (inviteBranches.error) return sendPgError(c, inviteBranches.error);

  const branchesByMember = new Map<string, string[]>();
  for (const row of memberBranches.data ?? []) {
    const list = branchesByMember.get(row.user_id) ?? [];
    list.push(row.branch_id);
    branchesByMember.set(row.user_id, list);
  }
  const branchesByInvite = new Map<string, string[]>();
  for (const row of inviteBranches.data ?? []) {
    const list = branchesByInvite.get(row.invite_id) ?? [];
    list.push(row.branch_id);
    branchesByInvite.set(row.invite_id, list);
  }

  return c.json([
    ...(members.data ?? []).map((row) => memberFromRow(row, branchesByMember.get(row.user_id) ?? [])),
    ...(invites.data ?? []).map((row) => inviteFromRow(row, branchesByInvite.get(row.id) ?? [])),
  ]);
});

app.patch('/api/employees/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.phone !== undefined) patch.phone = b.phone || null;
  if (b.department !== undefined) patch.department = b.department || null;
  if (b.roleId !== undefined) patch.role_id = b.roleId;
  if (b.status !== undefined) patch.status = b.status;

  const { error } = await auth.client
    .from('organization_members')
    .update(patch)
    .eq('user_id', c.req.valid('param').id)
    .eq('organization_id', auth.organizationId);
  if (error) return sendPgError(c, error);

  if (b.branchIds !== undefined) {
    const { error: branchError } = await auth.client.rpc('set_member_branch_access', {
      p_target_user_id: c.req.valid('param').id,
      p_branch_ids: b.branchIds,
    });
    if (branchError) return sendPgError(c, branchError);
  }

  return c.body(null, 204);
});

// Soft-remove — status = 'removed' cuts off data access to this one org (the
// current_organization_id() fail-closed check) without touching the
// person's membership in any other org, and without revoking an
// already-issued session token.
app.post('/api/employees/:id/remove', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client
    .from('organization_members')
    .update({ status: 'removed', updated_at: new Date().toISOString() })
    .eq('user_id', c.req.valid('param').id)
    .eq('organization_id', auth.organizationId);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Two distinct paths depending on whether the invited email already has an
// account (in this org or, now that an account can belong to several orgs,
// any org): admin.inviteUserByEmail() only works for a genuinely new email —
// it fails outright for one that's already registered. The service-role
// lookup below decides which path to take server-side, so the frontend form
// doesn't need to know in advance.
app.post('/api/employees/invites', validate('json', inviteBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const svc = createServiceClient(c.env);

  const { data: existing, error: lookupError } = await svc
    .from('profiles')
    .select('id')
    .eq('email', b.email)
    .maybeSingle();
  if (lookupError) return sendPgError(c, lookupError);

  if (existing) {
    const { error: rpcError } = await auth.client.rpc('invite_existing_user_to_organization', {
      p_target_user_id: existing.id,
      p_role_id: b.roleId,
      p_department: b.department || null,
      p_phone: b.phone || null,
      p_branch_ids: b.branchIds && b.branchIds.length > 0 ? b.branchIds : null,
    });
    if (rpcError) return sendPgError(c, rpcError);

    const { data: org } = await auth.client.from('organizations').select('name').eq('id', auth.organizationId).single();
    let emailSent = true;
    try {
      await sendInviteEmail(c.env, { to: b.email, orgName: org?.name ?? 'your team', appUrl: c.env.PUBLIC_APP_URL });
    } catch {
      // Non-critical — the pending invite already exists and is visible
      // in-app regardless of whether the notification email went out.
      emailSent = false;
    }

    return c.json({ path: 'existing_user', emailSent }, 201);
  }

  const { data: invite, error } = await auth.client
    .from('employee_invites')
    .insert({
      organization_id: auth.organizationId,
      invited_by: auth.userId,
      full_name: b.fullName,
      email: b.email,
      phone: b.phone || null,
      department: b.department || null,
      role_id: b.roleId,
    })
    .select('id')
    .single();
  if (error) return sendPgError(c, error);

  if (b.branchIds && b.branchIds.length > 0) {
    const { error: branchError } = await auth.client
      .from('employee_invite_branches')
      .insert(b.branchIds.map((branchId) => ({ invite_id: invite.id, branch_id: branchId })));
    if (branchError) {
      await auth.client.from('employee_invites').delete().eq('id', invite.id);
      return sendPgError(c, branchError);
    }
  }

  const { error: inviteError } = await svc.auth.admin.inviteUserByEmail(b.email, {
    data: { full_name: b.fullName },
    redirectTo: c.env.PUBLIC_APP_URL,
  });
  if (inviteError) {
    await auth.client.from('employee_invites').delete().eq('id', invite.id);
    const alreadyRegistered = /already registered|already exists/i.test(inviteError.message);
    const rateLimited = /rate limit/i.test(inviteError.message);
    const message = alreadyRegistered
      ? 'That email already has an account.'
      : rateLimited
        ? 'Too many invite emails sent recently — wait a few minutes and try again.'
        : inviteError.message;
    return c.json(
      { error: message, code: 'INVITE_FAILED' },
      alreadyRegistered ? 409 : rateLimited ? 429 : 500
    );
  }

  return c.json({ path: 'new_account' }, 201);
});

app.delete('/api/employees/invites/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('employee_invites').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
