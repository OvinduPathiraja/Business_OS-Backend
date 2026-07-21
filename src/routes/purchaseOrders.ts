import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const PO_STATUSES = ['draft', 'ordered', 'received', 'cancelled'] as const;
// A plain client PATCH can only ever move a purchase order between these
// three — 'received' is deliberately excluded here (matching the DB's own
// RLS `with check`) since it only ever happens through /receive.
const CLIENT_SETTABLE_STATUSES = ['draft', 'ordered', 'cancelled'] as const;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

// A purchase order line may reference a product (variantId, increases stock
// on receipt) or a subcontracted service (serviceId, payable-only) — never
// both, same latitude purchase_order_items' check constraint allows.
const lineItemSchema = z.object({
  serviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  name: z.string().trim().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
}).refine((it) => !(it.serviceId && it.variantId), {
  message: 'A line item cannot reference both a service and a product.',
});

const listQuery = paginationQuery.extend({ status: z.enum(PO_STATUSES).optional() });

const saveBody = z.object({
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string().trim().min(1),
  expectedDate: z.string().optional().nullable(),
  subtotal: z.number(),
  discount: z.number().min(0).optional(),
  tax: z.number(),
  total: z.number(),
  items: z.array(lineItemSchema).min(1),
  notes: z.string().optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
});

const statusBody = z.object({ status: z.enum(CLIENT_SETTABLE_STATUSES) });

const receiveBody = z.object({
  branchId: z.string().uuid().optional().nullable(),
  paymentAmount: z.number().min(0).optional().default(0),
  paymentMethod: z.enum(PAYMENT_METHODS).optional().nullable(),
  bankAccountId: z.string().uuid().optional().nullable(),
  cashRegisterId: z.string().uuid().optional().nullable(),
}).refine((b) => !(b.paymentAmount > 0 && !b.paymentMethod), {
  message: 'A payment method is required when recording a payment.',
  path: ['paymentMethod'],
});

const PO_SELECT = 'id, organization_id, supplier_id, supplier_name, po_number, status, order_date, expected_date, branch_id, subtotal, discount, tax, total, notes, bill_id, received_at, created_at, purchase_order_items(count)';
const PO_DETAIL_SELECT = 'id, organization_id, supplier_id, supplier_name, po_number, status, order_date, expected_date, branch_id, subtotal, discount, tax, total, notes, bill_id, received_at, created_at, purchase_order_items(id, service_id, variant_id, item_name, quantity, unit_cost, line_total)';

function poFromRow(row: any) {
  const itemCountRow = Array.isArray(row.purchase_order_items) ? row.purchase_order_items[0] : row.purchase_order_items;
  return {
    id: row.id, organizationId: row.organization_id, supplierId: row.supplier_id, supplierName: row.supplier_name,
    poNumber: row.po_number, status: row.status, orderDate: row.order_date, expectedDate: row.expected_date,
    branchId: row.branch_id, subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax),
    total: Number(row.total), notes: row.notes, billId: row.bill_id, receivedAt: row.received_at,
    itemCount: Number(itemCountRow?.count ?? 0), createdAt: row.created_at,
  };
}

function poWithItemsFromRow(row: any) {
  const items: any[] = Array.isArray(row.purchase_order_items) ? row.purchase_order_items : [];
  return {
    id: row.id, organizationId: row.organization_id, supplierId: row.supplier_id, supplierName: row.supplier_name,
    poNumber: row.po_number, status: row.status, orderDate: row.order_date, expectedDate: row.expected_date,
    branchId: row.branch_id, subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax),
    total: Number(row.total), notes: row.notes, billId: row.bill_id, receivedAt: row.received_at,
    itemCount: items.length, createdAt: row.created_at,
    items: items.map((it) => ({
      id: it.id, serviceId: it.service_id, variantId: it.variant_id, itemName: it.item_name,
      quantity: Number(it.quantity), unitCost: Number(it.unit_cost), lineTotal: Number(it.line_total),
    })),
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/purchase-orders', validate('query', listQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('purchase_orders').select(PO_SELECT).order('created_at', { ascending: false });
  const { search, status, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`po_number.ilike.%${search}%,supplier_name.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(poFromRow));
});

app.get('/api/purchase-orders/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('purchase_orders').select(PO_DETAIL_SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(poWithItemsFromRow(data));
});

// Wraps create_purchase_order() — atomic header + items insert, so an
// editable multi-item document never risks an orphaned header row from a
// partial client-side sequence.
app.post('/api/purchase-orders', validate('json', saveBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('create_purchase_order', {
    p_supplier_id: b.supplierId,
    p_supplier_name: b.supplierName,
    p_subtotal: b.subtotal,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitCost: it.unitCost })),
    p_notes: b.notes || null,
    p_expected_date: b.expectedDate || null,
    p_branch_id: b.branchId || null,
    p_discount: b.discount ?? 0,
  });
  if (error) return sendPgError(c, error);
  return c.json({ purchaseOrderId: data.purchaseOrderId, poNumber: data.poNumber }, 201);
});

app.patch('/api/purchase-orders/:id', validate('param', uuidParam), validate('json', saveBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.rpc('update_purchase_order', {
    p_purchase_order_id: c.req.valid('param').id,
    p_supplier_id: b.supplierId,
    p_supplier_name: b.supplierName,
    p_subtotal: b.subtotal,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitCost: it.unitCost })),
    p_notes: b.notes || null,
    p_expected_date: b.expectedDate || null,
    p_branch_id: b.branchId || null,
    p_discount: b.discount ?? 0,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Thin single-table transition (draft <-> ordered, or -> cancelled) — no
// item changes, no stock/payable side effects, so no RPC needed. The DB's
// own RLS `with check` also rejects 'received' here as a second line of
// defense even if this route's own enum were ever loosened.
app.patch('/api/purchase-orders/:id/status', validate('param', uuidParam), validate('json', statusBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('purchase_orders')
    .update({ status: c.req.valid('json').status, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(PO_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(poFromRow(data));
});

app.delete('/api/purchase-orders', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('purchase_orders').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps receive_purchase_order() — the sole point a purchase order is
// allowed to increment stock and create a payable. Always an explicit
// action; never triggered by any other purchase-order route.
app.post('/api/purchase-orders/:id/receive', validate('param', uuidParam), validate('json', receiveBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('receive_purchase_order', {
    p_purchase_order_id: c.req.valid('param').id,
    p_branch_id: b.branchId || null,
    p_payment_amount: b.paymentAmount ?? 0,
    p_payment_method: b.paymentMethod || null,
    p_bank_account_id: b.bankAccountId || null,
    p_cash_register_id: b.cashRegisterId || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ billId: data.billId, billNumber: data.billNumber, purchaseOrderId: data.purchaseOrderId, branchId: data.branchId }, 201);
});

export default app;
