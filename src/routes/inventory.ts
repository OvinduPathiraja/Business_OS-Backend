import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
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

export default async function inventoryRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/api/inventory/categories', async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('inventory_categories')
      .select('id, organization_id, name')
      .order('name', { ascending: true });
    if (error) return sendPgError(reply, error);
    reply.send((data ?? []).map((r: any) => ({ id: r.id, organizationId: r.organization_id, name: r.name })));
  });

  server.post('/api/inventory/categories', { schema: { body: categoryBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('inventory_categories')
      .insert({ organization_id: auth.organizationId, name: request.body.name })
      .select('id, organization_id, name')
      .single();
    if (error) return sendPgError(reply, error);
    reply.code(201).send({ id: data.id, organizationId: data.organization_id, name: data.name });
  });

  server.delete('/api/inventory/categories/:id', { schema: { params: uuidParam } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('inventory_categories').delete().eq('id', request.params.id);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });

  server.get('/api/inventory/items', { schema: { querystring: itemListQuery } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    let query = auth.client.from('inventory_items').select(ITEM_SELECT).order('created_at', { ascending: false });
    const { search, categoryId, limit, offset } = request.query;
    if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    if (categoryId) query = query.eq('category_id', categoryId);
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) return sendPgError(reply, error);
    reply.send((data ?? []).map(itemFromRow));
  });

  server.post('/api/inventory/items', { schema: { body: itemBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const b = request.body;
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
    if (error) return sendPgError(reply, error);
    reply.code(201).send(itemFromRow(data));
  });

  server.patch('/api/inventory/items/:id', { schema: { params: uuidParam, body: itemBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const b = request.body;
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
      .eq('id', request.params.id)
      .select(ITEM_SELECT)
      .single();
    if (error) return sendPgError(reply, error);
    reply.send(itemFromRow(data));
  });

  server.delete('/api/inventory/items', { schema: { body: bulkIdsBody } }, async (request, reply) => {
    const auth = await requireOrg(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('inventory_items').delete().in('id', request.body.ids);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });
}
