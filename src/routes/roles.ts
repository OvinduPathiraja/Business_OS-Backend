import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { uuidParam } from '../lib/schemas.js';

const roleBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  color: z.string().optional(),
});

const permissionsBody = z.object({ keys: z.array(z.string()) });

const ROLE_SELECT = 'id, organization_id, name, description, is_owner, color';

function roleFromRow(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, description: row.description, isOwner: row.is_owner, color: row.color };
}

export default async function rolesRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/api/roles', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('roles')
      .select(ROLE_SELECT)
      .order('is_owner', { ascending: false })
      .order('name', { ascending: true });
    if (error) return sendPgError(reply, error);
    reply.send((data ?? []).map(roleFromRow));
  });

  // Static reference data — same catalog for every organization. Cheap to
  // memoize in-process since it only ever changes via a migration.
  let permissionCatalogCache: any[] | null = null;
  server.get('/api/permissions', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    if (permissionCatalogCache) {
      reply.send(permissionCatalogCache);
      return;
    }
    const { data, error } = await auth.client
      .from('permissions')
      .select('id, key, feature, action, description')
      .order('feature', { ascending: true });
    if (error) return sendPgError(reply, error);
    permissionCatalogCache = data ?? [];
    reply.send(permissionCatalogCache);
  });

  server.get('/api/role-permissions', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client.from('role_permissions').select('role_id, permissions(key)');
    if (error) return sendPgError(reply, error);
    const map: Record<string, string[]> = {};
    (data ?? []).forEach((r: any) => {
      const key = Array.isArray(r.permissions) ? r.permissions[0]?.key : r.permissions?.key;
      if (!key) return;
      (map[r.role_id] ??= []).push(key);
    });
    reply.send(map);
  });

  server.get('/api/roles/employee-counts', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client.from('profiles').select('role_id').not('role_id', 'is', null);
    if (error) return sendPgError(reply, error);
    const counts: Record<string, number> = {};
    (data ?? []).forEach((r: any) => {
      if (!r.role_id) return;
      counts[r.role_id] = (counts[r.role_id] ?? 0) + 1;
    });
    reply.send(counts);
  });

  server.post('/api/roles', { schema: { body: roleBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('roles')
      .insert({
        organization_id: auth.organizationId,
        name: request.body.name,
        description: request.body.description || null,
        color: request.body.color ?? '#6D4AFF',
      })
      .select(ROLE_SELECT)
      .single();
    if (error) return sendPgError(reply, error);
    reply.code(201).send(roleFromRow(data));
  });

  // The Owner role can't be edited — RLS rejects it (is_owner = false in the
  // policy's USING clause) even for the owner themselves.
  server.patch('/api/roles/:id', { schema: { params: uuidParam, body: roleBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('roles')
      .update({ name: request.body.name, description: request.body.description || null, color: request.body.color })
      .eq('id', request.params.id)
      .select(ROLE_SELECT)
      .single();
    if (error) return sendPgError(reply, error);
    reply.send(roleFromRow(data));
  });

  server.delete('/api/roles/:id', { schema: { params: uuidParam } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('roles').delete().eq('id', request.params.id);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });

  // Wraps the set_role_permissions() RPC (added in
  // supabase/migrations/20260710120000_transactional_write_rpcs.sql) —
  // atomically replaces all of a role's grants, instead of the old
  // delete-then-select-then-insert client sequence.
  server.put('/api/roles/:id/permissions', { schema: { params: uuidParam, body: permissionsBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { error } = await auth.client.rpc('set_role_permissions', {
      p_role_id: request.params.id,
      p_keys: request.body.keys,
    });
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });
}
