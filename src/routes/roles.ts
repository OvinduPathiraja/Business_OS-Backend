import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
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

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/roles', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('roles')
    .select(ROLE_SELECT)
    .order('is_owner', { ascending: false })
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(roleFromRow));
});

// Static reference data — same catalog for every organization. Cheap to
// memoize per-isolate since it only ever changes via a migration. (Workers
// isolates are short-lived vs. a persistent Node process, so this caches
// less aggressively than the old Fastify version did, but still saves
// repeat queries within a warm isolate.)
let permissionCatalogCache: any[] | null = null;
app.get('/api/permissions', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  if (permissionCatalogCache) {
    return c.json(permissionCatalogCache);
  }
  const { data, error } = await auth.client
    .from('permissions')
    .select('id, key, feature, action, description')
    .order('feature', { ascending: true });
  if (error) return sendPgError(c, error);
  permissionCatalogCache = data ?? [];
  return c.json(permissionCatalogCache);
});

app.get('/api/role-permissions', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('role_permissions').select('role_id, permissions(key)');
  if (error) return sendPgError(c, error);
  const map: Record<string, string[]> = {};
  (data ?? []).forEach((r: any) => {
    const key = Array.isArray(r.permissions) ? r.permissions[0]?.key : r.permissions?.key;
    if (!key) return;
    (map[r.role_id] ??= []).push(key);
  });
  return c.json(map);
});

app.get('/api/roles/employee-counts', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('profiles').select('role_id').not('role_id', 'is', null);
  if (error) return sendPgError(c, error);
  const counts: Record<string, number> = {};
  (data ?? []).forEach((r: any) => {
    if (!r.role_id) return;
    counts[r.role_id] = (counts[r.role_id] ?? 0) + 1;
  });
  return c.json(counts);
});

app.post('/api/roles', validate('json', roleBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('roles')
    .insert({
      organization_id: auth.organizationId,
      name: body.name,
      description: body.description || null,
      color: body.color ?? '#6D4AFF',
    })
    .select(ROLE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(roleFromRow(data), 201);
});

// The Owner role can't be edited — RLS rejects it (is_owner = false in the
// policy's USING clause) even for the owner themselves.
app.patch('/api/roles/:id', validate('param', uuidParam), validate('json', roleBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('roles')
    .update({ name: body.name, description: body.description || null, color: body.color })
    .eq('id', c.req.valid('param').id)
    .select(ROLE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(roleFromRow(data));
});

app.delete('/api/roles/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('roles').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps the set_role_permissions() RPC — atomically replaces all of a
// role's grants, instead of the old delete-then-select-then-insert client
// sequence.
app.put('/api/roles/:id/permissions', validate('param', uuidParam), validate('json', permissionsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('set_role_permissions', {
    p_role_id: c.req.valid('param').id,
    p_keys: c.req.valid('json').keys,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
