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

// Sellable stock is merchandise (offered at checkout); internal stock is
// what the business consumes or owns but never sells. See
// supabase/migrations/20260726030000_inventory_item_kind.sql.
const ITEM_KINDS = ['sellable', 'internal'] as const;

const categoryBody = z.object({ name: z.string().trim().min(1) });

const itemListQuery = paginationQuery.extend({
  categoryId: z.string().uuid().optional(),
  kind: z.enum(ITEM_KINDS).optional(),
});

// Item-level fields only — sku/cost/price/quantity/reorder now live on the
// item's default variant (see product_variants/inventory_stock). Kept here
// on POST/create only for the initial default variant this creates; PATCH
// never touches them, matching create_product_item()/plain-update split.
//
// itemKind is the exception: PATCH does change it, but through the
// set_inventory_item_kind() RPC rather than the plain update below, because
// switching to internal also has to clear selling prices and refuse while
// the item sits on an open quotation.
const itemBody = z.object({
  name: z.string().trim().min(1),
  categoryId: z.string().uuid().optional().nullable(),
  unit: z.enum(UNITS),
  notes: z.string().optional().nullable(),
  itemKind: z.enum(ITEM_KINDS).optional(),
  imageUrl: z.string().trim().max(2048).optional().nullable(),
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

// Size-chart bulk add — one call for N sizes instead of N round trips (see
// add_product_variants() in supabase/migrations/20260729000000_product_variant_sizes.sql).
// Each element needs its own required unitPrice (not inherited server-side)
// so the RPC never has to guess a price; the client pre-fills it from the
// item's current default-variant price and lets the merchant override it.
const variantsBulkBody = z.object({
  variants: z.array(z.object({
    name: z.string().trim().min(1),
    sku: z.string().optional().nullable(),
    barcode: z.string().optional().nullable(),
    unitCost: z.number().optional().nullable(),
    unitPrice: z.number(),
  })).min(1).max(100),
});

const stockBody = z.object({
  quantityOnHand: z.number(),
  reorderPoint: z.number(),
});

const addStockBody = z.object({
  branchId: z.string().uuid(),
  quantity: z.number().positive(),
  purchasePrice: z.number().min(0),
  sellingPrice: z.number().min(0),
});

const BATCH_SELECT =
  'inventory_batches(id, branch_id, purchase_price, selling_price, quantity_received, quantity_remaining, source, received_at, purchase_order_id, purchase_orders(po_number))';

const ITEM_SELECT =
  'id, organization_id, category_id, name, unit, item_kind, notes, image_url, quantity_on_hand, reorder_point, created_at, updated_at, ' +
  'inventory_categories(name), ' +
  'product_variants(id, name, sku, barcode, unit_cost, unit_price, is_default, status, sort_order, ' +
  'inventory_stock(branch_id, quantity_on_hand, reorder_point, branches(name)), ' +
  `${BATCH_SELECT})`;

function stockFromRow(row: any) {
  const branch = Array.isArray(row.branches) ? row.branches[0] : row.branches;
  return {
    branchId: row.branch_id,
    branchName: branch?.name ?? null,
    quantityOnHand: Number(row.quantity_on_hand),
    reorderPoint: Number(row.reorder_point),
  };
}

function batchFromRow(row: any) {
  const po = Array.isArray(row.purchase_orders) ? row.purchase_orders[0] : row.purchase_orders;
  return {
    id: row.id,
    branchId: row.branch_id,
    purchasePrice: Number(row.purchase_price),
    sellingPrice: Number(row.selling_price),
    quantityReceived: Number(row.quantity_received),
    quantityRemaining: Number(row.quantity_remaining),
    source: row.source,
    receivedAt: row.received_at,
    purchaseOrderId: row.purchase_order_id,
    poNumber: po?.po_number ?? null,
  };
}

function variantFromRow(row: any) {
  const stock = Array.isArray(row.inventory_stock) ? row.inventory_stock : [];
  const batches = Array.isArray(row.inventory_batches) ? row.inventory_batches : [];
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
    batches: batches.map(batchFromRow),
  };
}

function itemFromRow(row: any) {
  const cat = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
  // sort_order first (a size chart's own order), name as the tiebreak for
  // pre-existing variants that all share the column default of 0 — see
  // supabase/migrations/20260729000000_product_variant_sizes.sql.
  const variants = (Array.isArray(row.product_variants) ? row.product_variants : [])
    .slice()
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)));
  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    categoryName: cat?.name ?? null,
    name: row.name,
    unit: row.unit,
    itemKind: row.item_kind ?? 'sellable',
    notes: row.notes,
    imageUrl: row.image_url,
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
  const { search, categoryId, kind, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`name.ilike.%${search}%`);
  if (categoryId) query = query.eq('category_id', categoryId);
  // Omitted entirely = both kinds, which is what the Inventory screen's "All"
  // tab wants; the two kind tabs pass it explicitly.
  if (kind) query = query.eq('item_kind', kind);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(itemFromRow));
});

// Lean, flat payload for the New Order product picker — every active
// SELLABLE variant with its price, per-branch stock, and open price/date lots
// (quantity_remaining > 0 only — sold-out lots are dead weight here), no
// item-level nesting.
//
// The item_kind filter is what keeps internal-use stock (cleaning supplies,
// tools, spare parts) out of New Order, the Cashier screen, quotations, and
// the checkout barcode scanner — all four read this one endpoint. It's the
// convenience half of the rule; the enforcing half is the
// guard_sellable_line_variant() trigger on order_items/quotation_items.
//
// !inner on the embed is load-bearing: without it PostgREST filters the
// embedded object but still returns the parent variant (with a null item),
// so every internal variant would come back nameless rather than not at all.
app.get('/api/inventory/variants', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('product_variants')
    .select('id, name, sku, barcode, unit_price, sort_order, inventory_item_id, inventory_items!inner(name, unit, item_kind), inventory_stock(branch_id, quantity_on_hand), inventory_batches(id, branch_id, purchase_price, selling_price, quantity_remaining, received_at)')
    .eq('status', 'active')
    .eq('inventory_items.item_kind', 'sellable');
  if (error) return sendPgError(c, error);

  // Grouped by item, then in size-chart order within it — not a flat
  // alphabetical-by-variant-name sort, which would scatter one product's
  // sizes apart from each other and sort "10, 11, 9" numerically wrong. Done
  // in JS rather than a PostgREST embedded-table .order() to avoid relying on
  // that syntax working the same way across embed shapes.
  const itemNameOf = (row: any) => {
    const item = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
    return item?.name ?? '';
  };
  const sorted = (data ?? []).slice().sort((a: any, b: any) =>
    itemNameOf(a).localeCompare(itemNameOf(b)) ||
    ((a.sort_order ?? 0) - (b.sort_order ?? 0)) ||
    String(a.name).localeCompare(String(b.name))
  );

  return c.json(sorted.map((row: any) => {
    const item = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
    const stock = Array.isArray(row.inventory_stock) ? row.inventory_stock : [];
    const batches = Array.isArray(row.inventory_batches) ? row.inventory_batches : [];
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
      batches: batches
        .filter((b: any) => Number(b.quantity_remaining) > 0)
        .map((b: any) => ({
          id: b.id, branchId: b.branch_id, purchasePrice: Number(b.purchase_price), sellingPrice: Number(b.selling_price),
          quantityRemaining: Number(b.quantity_remaining), receivedAt: b.received_at,
        }))
        .sort((a: any, b: any) => a.receivedAt.localeCompare(b.receivedAt)),
    };
  }));
});

// Records an inventory addition — a manual restock outside of a purchase
// order, distinct from create_product_item()'s initial-stock seeding.
// Creates (or folds into) a price/date lot via add_inventory_stock(), which
// also advances the variant's current cost/price to whatever was entered.
app.post('/api/inventory/variants/:variantId/batches', validate('param', z.object({ variantId: z.string().uuid() })), validate('json', addStockBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('add_inventory_stock', {
    p_variant_id: c.req.valid('param').variantId,
    p_branch_id: b.branchId,
    p_quantity: b.quantity,
    p_purchase_price: b.purchasePrice,
    p_selling_price: b.sellingPrice,
  });
  if (error) return sendPgError(c, error);

  const { data: row, error: fetchError } = await auth.client
    .from('product_variants')
    .select(`id, name, sku, barcode, unit_cost, unit_price, is_default, status, inventory_stock(branch_id, quantity_on_hand, reorder_point, branches(name)), ${BATCH_SELECT}`)
    .eq('id', c.req.valid('param').variantId)
    .single();
  if (fetchError) return sendPgError(c, fetchError);
  return c.json({ batchId: data.batchId, variant: variantFromRow(row) }, 201);
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
    p_item_kind: b.itemKind ?? 'sellable',
    p_image_url: b.imageUrl || null,
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

  // Kind first, and only through the RPC: it refuses the switch while the
  // item is on an open quotation and clears now-meaningless selling prices
  // when it succeeds. Run before the plain field update so a refusal leaves
  // the item completely untouched rather than half-saved.
  if (b.itemKind) {
    const { error: kindError } = await auth.client.rpc('set_inventory_item_kind', {
      p_item_id: c.req.valid('param').id,
      p_kind: b.itemKind,
    });
    if (kindError) return sendPgError(c, kindError);
  }

  const { data, error } = await auth.client
    .from('inventory_items')
    .update({
      category_id: b.categoryId || null,
      name: b.name,
      unit: b.unit,
      notes: b.notes || null,
      image_url: b.imageUrl || null,
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

// Size-chart bulk add — see add_product_variants() and variantsBulkBody's
// comment above. Returns the whole refreshed item (rather than just the new
// variants) so the caller can do one setEditing(item)-style replace instead
// of splicing an array in by hand.
app.post('/api/inventory/items/:id/variants/bulk', validate('param', uuidParam), validate('json', variantsBulkBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.rpc('add_product_variants', {
    p_inventory_item_id: c.req.valid('param').id,
    p_variants: b.variants.map((v) => ({
      name: v.name,
      sku: v.sku || null,
      barcode: v.barcode || null,
      unitCost: v.unitCost ?? null,
      unitPrice: v.unitPrice,
    })),
  });
  if (error) return sendPgError(c, error);

  const { data: row, error: fetchError } = await auth.client.from('inventory_items').select(ITEM_SELECT).eq('id', c.req.valid('param').id).single();
  if (fetchError) return sendPgError(c, fetchError);
  return c.json(itemFromRow(row), 201);
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
