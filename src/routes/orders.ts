import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

const listQuery = paginationQuery.extend({
  status: z.enum(['completed', 'refunded']).optional(),
  customerId: z.string().uuid().optional(),
});

const updateBody = z.object({
  customerId: z.string().uuid().nullable(),
  customerName: z.string().trim().min(1),
  notes: z.string().optional().nullable(),
});

const lineItemSchema = z.object({
  serviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  name: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
}).refine((it) => Boolean(it.serviceId) !== Boolean(it.variantId), {
  message: 'Each line item must have exactly one of serviceId or variantId.',
});

const completeOrderBody = z.object({
  customerId: z.string().uuid().nullable(),
  customerName: z.string().trim().min(1),
  subtotal: z.number(),
  discount: z.number().min(0).optional(),
  tax: z.number(),
  total: z.number(),
  items: z.array(lineItemSchema).min(1),
  paymentMethod: z.enum(PAYMENT_METHODS),
  branchId: z.string().uuid().optional().nullable(),
});

const ORDER_SELECT = 'id, organization_id, customer_id, customer_name, status, subtotal, discount, tax, total, notes, booking_id, branch_id, created_at, order_items(count)';
const ORDER_DETAIL_SELECT = 'id, organization_id, customer_id, customer_name, status, subtotal, discount, tax, total, notes, booking_id, branch_id, created_at, order_items(id, service_id, variant_id, item_name, quantity, unit_price, line_total)';

function orderFromRow(row: any) {
  const itemCountRow = Array.isArray(row.order_items) ? row.order_items[0] : row.order_items;
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
    status: row.status, subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax), total: Number(row.total),
    notes: row.notes, bookingId: row.booking_id, branchId: row.branch_id, itemCount: Number(itemCountRow?.count ?? 0), createdAt: row.created_at,
  };
}

function orderWithItemsFromRow(row: any) {
  const items: any[] = Array.isArray(row.order_items) ? row.order_items : [];
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
    status: row.status, subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax), total: Number(row.total),
    notes: row.notes, bookingId: row.booking_id, branchId: row.branch_id, itemCount: items.length, createdAt: row.created_at,
    items: items.map((it) => ({
      id: it.id, serviceId: it.service_id, variantId: it.variant_id, itemName: it.item_name,
      quantity: Number(it.quantity), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
    })),
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// Flat, org-wide order_items — used by the Reports aggregation to build a
// top-services breakdown.
app.get('/api/order-items', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('order_items').select('service_id, item_name, quantity, line_total, created_at');
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map((r: any) => ({
    serviceId: r.service_id, itemName: r.item_name, quantity: Number(r.quantity),
    lineTotal: Number(r.line_total), createdAt: r.created_at,
  })));
});

app.get('/api/orders', validate('query', listQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false });
  const { search, status, customerId, limit, offset } = c.req.valid('query');
  if (search) query = query.ilike('customer_name', `%${search}%`);
  if (status) query = query.eq('status', status);
  if (customerId) query = query.eq('customer_id', customerId);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(orderFromRow));
});

app.get('/api/orders/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('orders').select(ORDER_DETAIL_SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(orderWithItemsFromRow(data));
});

// Narrow, non-financial edit — customer link and notes only. Reversing a
// sale is the /refund action below, not this.
app.patch('/api/orders/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('orders')
    .update({ customer_id: body.customerId, customer_name: body.customerName, notes: body.notes || null })
    .eq('id', c.req.valid('param').id)
    .select(ORDER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(orderFromRow(data));
});

app.delete('/api/orders', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('orders').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// One-way 'completed' -> 'refunded'. Thin wrapper — refund_order() is
// already a correct, atomic SECURITY DEFINER RPC.
app.post('/api/orders/:id/refund', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('refund_order', { p_order_id: c.req.valid('param').id });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps the complete_order() RPC — atomically creates the order, its line
// items, the linked invoice, and the payment in one transaction, instead of
// 4 sequential client inserts.
app.post('/api/orders', validate('json', completeOrderBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const notes = b.items.map((it) => `${it.name} ×${it.quantity}`).join(', ');

  const { data, error } = await auth.client.rpc('complete_order', {
    p_customer_id: b.customerId,
    p_customer_name: b.customerName,
    p_subtotal: b.subtotal,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
    p_notes: notes,
    p_payment_method: b.paymentMethod,
    p_branch_id: b.branchId || null,
    p_discount: b.discount ?? 0,
  });
  if (error) return sendPgError(c, error);
  return c.json({ orderId: data.orderId, invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber, branchId: data.branchId, tokenNumber: data.tokenNumber ?? null }, 201);
});

export default app;
