import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

// Mirrors frontend/src/lib/inventory.ts's UNITS — weight, liquid, and count
// only (no distance/time units); weight and liquid each cover both metric
// and US customary. See supabase/migrations/20260724020000_inventory_units_weight_liquid_count.sql.
const UNITS = ['kg', 'g', 'lb', 'oz', 'l', 'ml', 'gal', 'fl_oz', 'each', 'box', 'pack', 'dozen', 'pair', 'set', 'roll'] as const;

const categoryBody = z.object({ name: z.string().trim().min(1) });

const itemListQuery = paginationQuery.extend({ categoryId: z.string().uuid().optional() });

// Item-level fields only — sku/cost/price/quantity/reorder now live on the
// item's default variant (see product_variants/inventory_stock). Kept here
// on POST/create only for the initial default variant this creates; PATCH
// never touches them, matching create_product_item()/plain-update split.
const itemBody = z.object({
  name: z.string().trim().min(1),
  categoryId: z.string().uuid().optional().nullable(),
  unit: z.enum(UNITS),
  notes: z.string().optional().nullable(),
});

const createItemBody = itemBody.extend({
  sku: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  unitCost: z.number().optional().nullable(),
  unitPrice: z.number().optional().nullable(),
  quantityOnHand: z.number(),
  reorderPoint: z.number(),
  branchId: z.string().uuid().optional().nullable(),
});

const variantBody = z.object({
  name: z.string().trim().min(1).optional(),
  sku: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  unitCost: z.number().optional().nullable(),
  unitPrice: z.number(),
});

const stockBody = z.object({
  quantityOnHand: z.number(),
  reorderPoint: z.number(),
});

const ITEM_SELECT =
  'id, organization_id, category_id, name, unit, notes, quantity_on_hand, reorder_point, created_at, updated_at, ' +
  'inventory_categories(name), ' +
  'product_variants(id, name, sku, barcode, unit_cost, unit_price, is_default, status, ' +
  'inventory_stock(branch_id, quantity_on_hand, reorder_point, branches(name)))';

function stockFromRow(row: any) {
  const branch = Array.isArray(row.branches) ? row.branches[0] : row.branches;
  return {
    branchId: row.branch_id,
    branchName: branch?.name ?? null,
    quantityOnHand: Number(row.quantity_on_hand),
    reorderPoint: Number(row.reorder_point),
  };
}

function variantFromRow(row: any) {
  const stock = Array.isArray(row.inventory_stock) ? row.inventory_stock : [];
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
    unitPrice: Number(row.unit_price),
    isDefault: row.is_default,
    status: row.status,
    stockByBranch: stock.map(stockFromRow),
  };
}

function itemFromRow(row: any) {
  const cat = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
  const variants = Array.isArray(row.product_variants) ? row.product_variants : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    categoryName: cat?.name ?? null,
    name: row.name,
    unit: row.unit,
    notes: row.notes,
    quantityOnHand: Number(row.quantity_on_hand),
    reorderPoint: Number(row.reorder_point),
    createdAt: row.created_at,
    variants: variants.map(variantFromRow),
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

app.patch('/api/inventory/categories/:id', validate('param', uuidParam), validate('json', categoryBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('inventory_categories')
    .update({ name: c.req.valid('json').name })
    .eq('id', c.req.valid('param').id)
    .select('id, organization_id, name')
    .single();
  if (error) return sendPgError(c, error);
  return c.json({ id: data.id, organizationId: data.organization_id, name: data.name });
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
  if (search) query = query.or(`name.ilike.%${search}%`);
  if (categoryId) query = query.eq('category_id', categoryId);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(itemFromRow));
});

// Lean, flat payload for the New Order product picker — every active
// variant with its price and per-branch stock, no item-level nesting.
app.get('/api/inventory/variants', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('product_variants')
    .select('id, name, sku, barcode, unit_price, inventory_item_id, inventory_items(name, unit), inventory_stock(branch_id, quantity_on_hand)')
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map((row: any) => {
    const item = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
    const stock = Array.isArray(row.inventory_stock) ? row.inventory_stock : [];
    return {
      id: row.id,
      itemId: row.inventory_item_id,
      itemName: item?.name ?? '',
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      unitPrice: Number(row.unit_price),
      unit: item?.unit ?? 'each',
      stockByBranch: stock.map((s: any) => ({ branchId: s.branch_id, quantityOnHand: Number(s.quantity_on_hand) })),
    };
  }));
});

app.post('/api/inventory/items', validate('json', createItemBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('create_product_item', {
    p_name: b.name,
    p_category_id: b.categoryId || null,
    p_unit: b.unit,
    p_notes: b.notes || null,
    p_sku: b.sku || null,
    p_barcode: b.barcode || null,
    p_unit_cost: b.unitCost ?? null,
    p_unit_price: b.unitPrice ?? null,
    p_quantity_on_hand: b.quantityOnHand,
    p_reorder_point: b.reorderPoint,
    p_branch_id: b.branchId || null,
  });
  if (error) return sendPgError(c, error);

  const { data: row, error: fetchError } = await auth.client.from('inventory_items').select(ITEM_SELECT).eq('id', data.itemId).single();
  if (fetchError) return sendPgError(c, fetchError);
  return c.json(itemFromRow(row), 201);
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
      unit: b.unit,
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

app.post('/api/inventory/items/:id/variants', validate('param', uuidParam), validate('json', variantBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('add_product_variant', {
    p_inventory_item_id: c.req.valid('param').id,
    p_name: b.name || 'Variant',
    p_sku: b.sku || null,
    p_barcode: b.barcode || null,
    p_unit_cost: b.unitCost ?? null,
    p_unit_price: b.unitPrice,
  });
  if (error) return sendPgError(c, error);

  const { data: row, error: fetchError } = await auth.client
    .from('product_variants')
    .select('id, name, sku, barcode, unit_cost, unit_price, is_default, status, inventory_stock(branch_id, quantity_on_hand, reorder_point, branches(name))')
    .eq('id', data.variantId)
    .single();
  if (fetchError) return sendPgError(c, fetchError);
  return c.json(variantFromRow(row), 201);
});

app.patch('/api/inventory/variants/:id', validate('param', uuidParam), validate('json', variantBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('product_variants')
    .update({
      ...(b.name ? { name: b.name } : {}),
      sku: b.sku || null,
      barcode: b.barcode || null,
      unit_cost: b.unitCost ?? null,
      unit_price: b.unitPrice,
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select('id, name, sku, barcode, unit_cost, unit_price, is_default, status, inventory_stock(branch_id, quantity_on_hand, reorder_point, branches(name))')
    .single();
  if (error) return sendPgError(c, error);
  return c.json(variantFromRow(data));
});

app.delete('/api/inventory/variants', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('product_variants').delete().in('id', c.req.valid('json').ids).eq('is_default', false);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Plain client-writable stock edit — matches this schema's precedent for
// simple, non-balance-racing field edits (e.g. bank_transactions.reconciled).
app.patch('/api/inventory/variants/:variantId/stock/:branchId', validate('json', stockBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { variantId, branchId } = c.req.param();
  const { data, error } = await auth.client
    .from('inventory_stock')
    .update({ quantity_on_hand: b.quantityOnHand, reorder_point: b.reorderPoint, updated_at: new Date().toISOString() })
    .eq('variant_id', variantId)
    .eq('branch_id', branchId)
    .select('branch_id, quantity_on_hand, reorder_point, branches(name)')
    .single();
  if (error) return sendPgError(c, error);
  return c.json(stockFromRow(data));
});

export default app;
