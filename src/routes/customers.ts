import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const LIFECYCLE_STAGES = ['lead', 'active', 'vip', 'dormant', 'archived'] as const;

const listQuery = paginationQuery.extend({
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
});

const customerBody = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
  notes: z.string().optional().nullable(),
});

const SELECT = 'id, organization_id, name, email, phone, lifecycle_stage, notes, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    lifecycleStage: row.lifecycle_stage,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/customers', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('customers').select(SELECT).order('created_at', { ascending: false });
  const { search, lifecycleStage, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  if (lifecycleStage) query = query.eq('lifecycle_stage', lifecycleStage);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/customers', validate('json', customerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('customers')
    .insert({
      organization_id: auth.organizationId,
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      lifecycle_stage: body.lifecycleStage ?? 'lead',
      notes: body.notes || null,
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/customers/:id', validate('param', uuidParam), validate('json', customerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('customers')
    .update({
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      lifecycle_stage: body.lifecycleStage,
      notes: body.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.delete('/api/customers', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('customers').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
