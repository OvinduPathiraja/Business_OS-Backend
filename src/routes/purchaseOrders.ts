import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError, pgErrorResult } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
import { purchaseOrderTemplateSchema } from '../lib/purchaseOrderTemplateSchema.js';
import { withIdempotency } from '../lib/idempotency.js';

const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled'] as const;
// A plain client PATCH can only ever move a purchase order between these
// three — 'partially_received'/'received' are deliberately excluded here
// (matching the DB's own RLS `with check`) since they only ever happen
// through /receive.
const CLIENT_SETTABLE_STATUSES = ['draft', 'ordered', 'cancelled'] as const;
// The status a purchase order can be created directly into — same two, but
// expressed separately since "cancelled" is never a valid starting point.
const CREATE_STATUSES = ['draft', 'ordered'] as const;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;
const PO_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'] as const;

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
  paymentTerms: z.string().trim().max(120).optional().nullable(),
  paymentStatus: z.enum(PO_PAYMENT_STATUSES).optional(),
  expectedPaymentAmount: z.number().min(0).optional(),
});

const createBody = saveBody.extend({
  status: z.enum(CREATE_STATUSES).optional(),
});

const statusBody = z.object({ status: z.enum(CLIENT_SETTABLE_STATUSES) });

const receiveItemSchema = z.object({
  itemId: z.string().uuid(),
  quantityReceived: z.number().min(0),
});

const receiveBody = z.object({
  branchId: z.string().uuid().optional().nullable(),
  paymentAmount: z.number().min(0).optional().default(0),
  paymentMethod: z.enum(PAYMENT_METHODS).optional().nullable(),
  bankAccountId: z.string().uuid().optional().nullable(),
  cashRegisterId: z.string().uuid().optional().nullable(),
  // Per-line received quantity for this receiving event — a line left out
  // (or the whole array omitted) defaults to "receive what's left on it",
  // so a full one-shot receive needs nothing here.
  items: z.array(receiveItemSchema).optional(),
}).refine((b) => !(b.paymentAmount > 0 && !b.paymentMethod), {
  message: 'A payment method is required when recording a payment.',
  path: ['paymentMethod'],
});

const poSettingsBody = z.object({
  logoUrl: z.string().trim().max(2048).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().max(255).optional().nullable(),
  accentColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  footerText: z.string().trim().max(1000).optional().nullable(),
  termsText: z.string().trim().max(2000).optional().nullable(),
  template: purchaseOrderTemplateSchema.optional().nullable(),
});

const PO_SETTINGS_SELECT = 'logo_url, address, phone, email, accent_color, footer_text, terms_text, template';

function poSettingsFromRow(row: any) {
  return {
    logoUrl: row?.logo_url ?? null,
    address: row?.address ?? null,
    phone: row?.phone ?? null,
    email: row?.email ?? null,
    accentColor: row?.accent_color ?? '#1A1D23',
    footerText: row?.footer_text ?? null,
    termsText: row?.terms_text ?? null,
    template: row?.template ?? null,
  };
}

const PO_SELECT = 'id, organization_id, supplier_id, supplier_name, po_number, status, order_date, expected_date, branch_id, subtotal, discount, tax, total, notes, bill_id, received_at, payment_terms, payment_status, expected_payment_amount, created_at, purchase_order_items(count)';
const PO_DETAIL_SELECT = 'id, organization_id, supplier_id, supplier_name, po_number, status, order_date, expected_date, branch_id, subtotal, discount, tax, total, notes, bill_id, received_at, payment_terms, payment_status, expected_payment_amount, created_at, purchase_order_items(id, service_id, variant_id, item_name, quantity, unit_cost, quantity_received, line_total)';

function poFromRow(row: any) {
  const itemCountRow = Array.isArray(row.purchase_order_items) ? row.purchase_order_items[0] : row.purchase_order_items;
  return {
    id: row.id, organizationId: row.organization_id, supplierId: row.supplier_id, supplierName: row.supplier_name,
    poNumber: row.po_number, status: row.status, orderDate: row.order_date, expectedDate: row.expected_date,
    branchId: row.branch_id, subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax),
    total: Number(row.total), notes: row.notes, billId: row.bill_id, receivedAt: row.received_at,
    paymentTerms: row.payment_terms ?? null,
    paymentStatus: row.payment_status ?? 'unpaid', expectedPaymentAmount: Number(row.expected_payment_amount ?? 0),
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
    paymentTerms: row.payment_terms ?? null,
    paymentStatus: row.payment_status ?? 'unpaid', expectedPaymentAmount: Number(row.expected_payment_amount ?? 0),
    itemCount: items.length, createdAt: row.created_at,
    items: items.map((it) => ({
      id: it.id, serviceId: it.service_id, variantId: it.variant_id, itemName: it.item_name,
      quantity: Number(it.quantity), unitCost: Number(it.unit_cost), quantityReceived: Number(it.quantity_received ?? 0),
      lineTotal: Number(it.line_total),
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
app.post('/api/purchase-orders', validate('json', createBody), async (c) => {
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
    p_status: b.status ?? 'draft',
    p_payment_terms: b.paymentTerms || null,
    p_payment_status: b.paymentStatus ?? 'unpaid',
    p_expected_payment_amount: b.expectedPaymentAmount ?? 0,
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
    p_payment_terms: b.paymentTerms || null,
    p_payment_status: b.paymentStatus ?? 'unpaid',
    p_expected_payment_amount: b.expectedPaymentAmount ?? 0,
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
  // requireOrg (not requireUser) so withIdempotency() has an organizationId
  // to scope the claim by — H-NEW-1 fix, 2026-08-06 security assessment.
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  return withIdempotency(c, auth, 'POST /api/purchase-orders/:id/receive', async () => {
    const { data, error } = await auth.client.rpc('receive_purchase_order', {
      p_purchase_order_id: c.req.valid('param').id,
      p_branch_id: b.branchId || null,
      p_payment_amount: b.paymentAmount ?? 0,
      p_payment_method: b.paymentMethod || null,
      p_bank_account_id: b.bankAccountId || null,
      p_cash_register_id: b.cashRegisterId || null,
      p_items: b.items && b.items.length > 0 ? b.items.map((it) => ({ itemId: it.itemId, quantityReceived: it.quantityReceived })) : null,
    });
    if (error) return pgErrorResult(error);
    return {
      status: 201,
      body: { billId: data.billId, billNumber: data.billNumber, purchaseOrderId: data.purchaseOrderId, branchId: data.branchId, status: data.status },
    };
  });
});

app.get('/api/organization/purchase-order-settings', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('organization_purchase_order_settings')
    .select(PO_SETTINGS_SELECT)
    .eq('organization_id', auth.organizationId)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  return c.json(poSettingsFromRow(data));
});

app.patch('/api/organization/purchase-order-settings', validate('json', poSettingsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.from('organization_purchase_order_settings').upsert(
    {
      organization_id: auth.organizationId,
      ...(b.logoUrl !== undefined ? { logo_url: b.logoUrl || null } : {}),
      ...(b.address !== undefined ? { address: b.address || null } : {}),
      ...(b.phone !== undefined ? { phone: b.phone || null } : {}),
      ...(b.email !== undefined ? { email: b.email || null } : {}),
      ...(b.accentColor !== undefined ? { accent_color: b.accentColor } : {}),
      ...(b.footerText !== undefined ? { footer_text: b.footerText || null } : {}),
      ...(b.termsText !== undefined ? { terms_text: b.termsText || null } : {}),
      ...(b.template !== undefined ? { template: b.template } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' }
  );
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Aggregates everything a printable purchase order needs — org name for the
// letterhead, the PO's own real line items, and best-effort settings. Same
// shape as GET /api/quotations/:id/print.
app.get('/api/purchase-orders/:id/print', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('purchase_orders')
    .select(`${PO_DETAIL_SELECT}, organizations(name)`)
    .eq('id', c.req.valid('param').id)
    .single();
  if (error) return sendPgError(c, error);

  const row = data as any;
  const purchaseOrder = poWithItemsFromRow(row);

  const { data: settingsRow } = await auth.client
    .from('organization_purchase_order_settings')
    .select(PO_SETTINGS_SELECT)
    .eq('organization_id', row.organization_id)
    .maybeSingle();

  return c.json({
    purchaseOrder,
    organizationName: row.organizations?.name ?? '',
    lineItems: purchaseOrder.items.map((it: any) => ({ name: it.itemName, quantity: it.quantity, unitPrice: it.unitCost, lineTotal: it.lineTotal })),
    purchaseOrderSettings: poSettingsFromRow(settingsRow),
  });
});

export default app;
