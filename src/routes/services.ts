import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const SORT_FIELDS = ['name', 'price'] as const;
const SORT_COLUMNS: Record<(typeof SORT_FIELDS)[number], string> = { name: 'name', price: 'price' };

const listQuery = paginationQuery.extend({
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
});

const serviceBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  price: z.number().min(0).optional(),
  durationOptions: z.array(z.number().positive()).optional(),
  allowsTime: z.boolean().optional(),
  allowsSlot: z.boolean().optional(),
  tint: z.string().optional(),
  icon: z.string().optional(),
});

const SELECT = 'id, organization_id, name, description, price, duration_options, allows_time, allows_slot, tint, icon';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    durationOptions: (row.duration_options ?? []).map(Number),
    allowsTime: row.allows_time,
    allowsSlot: row.allows_slot,
    tint: row.tint,
    icon: row.icon,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/services', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, sort, order, limit, offset } = c.req.valid('query');
  let query = auth.client.from('services').select(SELECT, { count: 'exact' })
    .order(sort ? SORT_COLUMNS[sort] : 'name', { ascending: sort ? order === 'asc' : true });
  if (search) query = query.ilike('name', `%${search}%`);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/services', validate('json', serviceBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('services')
    .insert({
      organization_id: auth.organizationId,
      name: b.name,
      description: b.description || null,
      price: b.price ?? 0,
      duration_options: b.durationOptions ?? [],
      allows_time: b.allowsTime ?? true,
      allows_slot: b.allowsSlot ?? true,
      ...(b.tint ? { tint: b.tint } : {}),
      ...(b.icon ? { icon: b.icon } : {}),
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/services/:id', validate('param', uuidParam), validate('json', serviceBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('services')
    .update({
      name: b.name,
      description: b.description || null,
      price: b.price ?? 0,
      duration_options: b.durationOptions ?? [],
      allows_time: b.allowsTime ?? true,
      allows_slot: b.allowsSlot ?? true,
      ...(b.tint ? { tint: b.tint } : {}),
      ...(b.icon ? { icon: b.icon } : {}),
    })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.delete('/api/services', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('services').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
