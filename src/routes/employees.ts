import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
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

export default async function employeesRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // A single logical list merging real members and pending invites, done
  // server-side (was 2 client round trips, frontend/src/lib/employees.ts
  // previously merged them in the browser).
  server.get('/api/employees', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const [profiles, invites] = await Promise.all([
      auth.client.from('profiles').select(PROFILE_SELECT).not('role_id', 'is', null).order('created_at', { ascending: false }),
      auth.client.from('employee_invites').select(INVITE_SELECT).order('invited_at', { ascending: false }),
    ]);
    if (profiles.error) return sendPgError(reply, profiles.error);
    if (invites.error) return sendPgError(reply, invites.error);
    reply.send([...(profiles.data ?? []).map(memberFromRow), ...(invites.data ?? []).map(inviteFromRow)]);
  });

  server.patch('/api/employees/:id', { schema: { params: uuidParam, body: updateBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const b = request.body;
    const patch: Record<string, any> = {};
    if (b.phone !== undefined) patch.phone = b.phone || null;
    if (b.department !== undefined) patch.department = b.department || null;
    if (b.roleId !== undefined) patch.role_id = b.roleId;
    if (b.status !== undefined) patch.status = b.status;

    const { error } = await auth.client.from('profiles').update(patch).eq('id', request.params.id);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });

  // Soft-remove — status = 'removed' cuts off data access (see the
  // current_organization_id() fail-closed change) but doesn't revoke an
  // already-issued session token. Deliberately its own action (not a
  // generic PATCH ...status) matching how EmployeeUpdateInput's status
  // union excludes 'removed'.
  server.post('/api/employees/:id/remove', { schema: { params: uuidParam } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('profiles').update({ status: 'removed' }).eq('id', request.params.id);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });

  // Directory-only for now — see the TODO in frontend/src/lib/employees.ts
  // for why this doesn't yet create a real account.
  server.post('/api/employees/invites', { schema: { body: inviteBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const b = request.body;
    const { error } = await auth.client.from('employee_invites').insert({
      organization_id: auth.organizationId,
      invited_by: auth.userId,
      full_name: b.fullName,
      email: b.email,
      phone: b.phone || null,
      department: b.department || null,
      role_id: b.roleId,
    });
    if (error) return sendPgError(reply, error);
    reply.code(201).send();
  });

  server.delete('/api/employees/invites/:id', { schema: { params: uuidParam } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('employee_invites').delete().eq('id', request.params.id);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });
}
