import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const UNITS = ['each', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'box', 'pack', 'dozen', 'pair', 'hour', 'set', 'roll'] as const;

const categoryBody = z.object({ name: z.string().trim().min(1) });

const itemListQuery = paginationQuery.extend({ categoryId: z.string().uuid().optional() });

const itemBody = z.object({
  name: z.string().trim().min(1),
  sku: z.string().optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  unit: z.enum(UNITS),
  quantityOnHand: z.number(),
  reorderPoint: z.number(),
  unitCost: z.number().optional().nullable(),
  unitPrice: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const ITEM_SELECT = 'id, organization_id, category_id, name, sku, unit, quantity_on_hand, reorder_point, unit_cost, unit_price, notes, created_at, inventory_categories(name)';

function itemFromRow(row: any) {
  const cat = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    categoryName: cat?.name ?? null,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    quantityOnHand: Number(row.quantity_on_hand),
    reorderPoint: Number(row.reorder_point),
    unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/inventory/categories', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('inventory_categories')
    .select('id, organization_id, name')
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map((r: any) => ({ id: r.id, organizationId: r.organization_id, name: r.name })));
});

app.post('/api/inventory/categories', validate('json', categoryBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('inventory_categories')
    .insert({ organization_id: auth.organizationId, name: c.req.valid('json').name })
    .select('id, organization_id, name')
    .single();
  if (error) return sendPgError(c, error);
  return c.json({ id: data.id, organizationId: data.organization_id, name: data.name }, 201);
});

app.delete('/api/inventory/categories/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('inventory_categories').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/inventory/items', validate('query', itemListQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('inventory_items').select(ITEM_SELECT).order('created_at', { ascending: false });
  const { search, categoryId, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
  if (categoryId) query = query.eq('category_id', categoryId);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(itemFromRow));
});

app.post('/api/inventory/items', validate('json', itemBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('inventory_items')
    .insert({
      organization_id: auth.organizationId,
      category_id: b.categoryId || null,
      name: b.name,
      sku: b.sku || null,
      unit: b.unit,
      quantity_on_hand: b.quantityOnHand,
      reorder_point: b.reorderPoint,
      unit_cost: b.unitCost ?? null,
      unit_price: b.unitPrice ?? null,
      notes: b.notes || null,
    })
    .select(ITEM_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(itemFromRow(data), 201);
});

app.patch('/api/inventory/items/:id', validate('param', uuidParam), validate('json', itemBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('inventory_items')
    .update({
      category_id: b.categoryId || null,
      name: b.name,
      sku: b.sku || null,
      unit: b.unit,
      quantity_on_hand: b.quantityOnHand,
      reorder_point: b.reorderPoint,
      unit_cost: b.unitCost ?? null,
      unit_price: b.unitPrice ?? null,
      notes: b.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(ITEM_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(itemFromRow(data));
});

app.delete('/api/inventory/items', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('inventory_items').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
