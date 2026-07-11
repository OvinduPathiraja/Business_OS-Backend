import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../lib/supabase.js';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const inviteBody = z.object({
  fullName: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  roleId: z.string().uuid(),
});

const updateBody = z.object({
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['active', 'on_leave']).optional(),
});

const PROFILE_SELECT = 'id, full_name, email, phone, department, role_id, status, created_at, roles(name)';
const INVITE_SELECT = 'id, full_name, email, phone, department, role_id, status, invited_at, roles(name)';

function roleNameFrom(row: any): string | null {
  const roles = row.roles as { name: string } | { name: string }[] | null;
  return Array.isArray(roles) ? roles[0]?.name ?? null : roles?.name ?? null;
}

function memberFromRow(row: any) {
  return {
    id: row.id, kind: 'member', fullName: row.full_name ?? '(no name)', email: row.email,
    phone: row.phone, department: row.department, roleId: row.role_id, roleName: roleNameFrom(row),
    status: row.status, createdAt: row.created_at,
  };
}
function inviteFromRow(row: any) {
  return {
    id: row.id, kind: 'invited', fullName: row.full_name, email: row.email,
    phone: row.phone, department: row.department, roleId: row.role_id, roleName: roleNameFrom(row),
    status: 'invited', createdAt: row.invited_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// A single logical list merging real members and pending invites, done
// server-side (was 2 client round trips, frontend/src/lib/employees.ts
// previously merged them in the browser).
app.get('/api/employees', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const [profiles, invites] = await Promise.all([
    auth.client.from('profiles').select(PROFILE_SELECT).not('role_id', 'is', null).order('created_at', { ascending: false }),
    auth.client.from('employee_invites').select(INVITE_SELECT).order('invited_at', { ascending: false }),
  ]);
  if (profiles.error) return sendPgError(c, profiles.error);
  if (invites.error) return sendPgError(c, invites.error);
  return c.json([...(profiles.data ?? []).map(memberFromRow), ...(invites.data ?? []).map(inviteFromRow)]);
});

app.patch('/api/employees/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const patch: Record<string, any> = {};
  if (b.phone !== undefined) patch.phone = b.phone || null;
  if (b.department !== undefined) patch.department = b.department || null;
  if (b.roleId !== undefined) patch.role_id = b.roleId;
  if (b.status !== undefined) patch.status = b.status;

  const { error } = await auth.client.from('profiles').update(patch).eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Soft-remove — status = 'removed' cuts off data access (see the
// current_organization_id() fail-closed change) but doesn't revoke an
// already-issued session token. Deliberately its own action (not a
// generic PATCH ...status) matching how EmployeeUpdateInput's status
// union excludes 'removed'.
app.post('/api/employees/:id/remove', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('profiles').update({ status: 'removed' }).eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Creates the employee_invites staging row first (still via the caller's
// RLS-scoped client — employees.add still gates this exactly as before),
// then a real Supabase Auth account via the Admin API. The `handle_new_user`
// trigger (supabase/migrations/20260711120000_invite_attach_on_signup.sql)
// finds this row by email the instant the new auth.users row is created and
// attaches organization_id/role_id/phone/department atomically, then deletes
// it — so if the Admin API call fails, the staging row is rolled back here
// (compensating delete) rather than left dangling with no invite ever sent.
app.post('/api/employees/invites', validate('json', inviteBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
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

  const svc = createServiceClient(c.env);
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

  return c.body(null, 201);
});

app.delete('/api/employees/invites/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('employee_invites').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
