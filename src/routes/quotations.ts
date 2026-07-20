import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
import { quotationTemplateSchema } from '../lib/quotationTemplateSchema.js';
import { sendInvoiceEmail } from '../lib/email.js';

const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

// Relaxed to "at most one" of serviceId/variantId (not orders.ts's "exactly
// one") — a quotation line may be a freeform custom line with no catalog
// reference at all, same latitude quotation_items' check constraint allows.
const lineItemSchema = z.object({
  serviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  name: z.string().trim().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
}).refine((it) => !(it.serviceId && it.variantId), {
  message: 'A line item cannot reference both a service and a product.',
});

const listQuery = paginationQuery.extend({ status: z.enum(QUOTATION_STATUSES).optional() });

const saveBody = z.object({
  customerId: z.string().uuid().nullable(),
  customerName: z.string().trim().min(1),
  status: z.enum(QUOTATION_STATUSES).optional(),
  issueDate: z.string(),
  expiryDate: z.string().optional().nullable(),
  subtotal: z.number(),
  discount: z.number().min(0).optional(),
  tax: z.number(),
  total: z.number(),
  items: z.array(lineItemSchema).min(1),
  notes: z.string().optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
});

const statusBody = z.object({ status: z.enum(QUOTATION_STATUSES) });

const convertBody = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  branchId: z.string().uuid().optional().nullable(),
});

const emailQuotationBody = z.object({
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(200).optional(),
  html: z.string().min(1).max(500_000),
});

const quotationSettingsBody = z.object({
  logoUrl: z.string().trim().max(2048).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().max(255).optional().nullable(),
  accentColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  footerText: z.string().trim().max(1000).optional().nullable(),
  termsText: z.string().trim().max(2000).optional().nullable(),
  template: quotationTemplateSchema.optional().nullable(),
});

const QUOTATION_SETTINGS_SELECT = 'logo_url, address, phone, email, accent_color, footer_text, terms_text, template';

function quotationSettingsFromRow(row: any) {
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

const QUOTATION_SELECT = 'id, organization_id, customer_id, customer_name, quotation_number, status, issue_date, expiry_date, subtotal, discount, tax, total, notes, branch_id, converted_order_id, converted_at, created_at, quotation_items(count)';
const QUOTATION_DETAIL_SELECT = 'id, organization_id, customer_id, customer_name, quotation_number, status, issue_date, expiry_date, subtotal, discount, tax, total, notes, branch_id, converted_order_id, converted_at, created_at, quotation_items(id, service_id, variant_id, item_name, quantity, unit_price, line_total)';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// A stored 'draft'/'sent' quotation past its expiry date displays as
// 'expired' without ever mutating the stored column — no scheduled-task
// infrastructure exists in this codebase to flip it persistently, and
// deriving it at read time is simpler and always correct.
function effectiveStatus(row: any): string {
  if ((row.status === 'draft' || row.status === 'sent') && row.expiry_date && row.expiry_date < todayISO()) {
    return 'expired';
  }
  return row.status;
}

function quotationFromRow(row: any) {
  const itemCountRow = Array.isArray(row.quotation_items) ? row.quotation_items[0] : row.quotation_items;
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
    quotationNumber: row.quotation_number, status: effectiveStatus(row), issueDate: row.issue_date, expiryDate: row.expiry_date,
    subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax), total: Number(row.total),
    notes: row.notes, branchId: row.branch_id, convertedOrderId: row.converted_order_id, convertedAt: row.converted_at,
    itemCount: Number(itemCountRow?.count ?? 0), createdAt: row.created_at,
  };
}

function quotationWithItemsFromRow(row: any) {
  const items: any[] = Array.isArray(row.quotation_items) ? row.quotation_items : [];
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
    quotationNumber: row.quotation_number, status: effectiveStatus(row), issueDate: row.issue_date, expiryDate: row.expiry_date,
    subtotal: Number(row.subtotal), discount: Number(row.discount ?? 0), tax: Number(row.tax), total: Number(row.total),
    notes: row.notes, branchId: row.branch_id, convertedOrderId: row.converted_order_id, convertedAt: row.converted_at,
    itemCount: items.length, createdAt: row.created_at,
    items: items.map((it) => ({
      id: it.id, serviceId: it.service_id, variantId: it.variant_id, itemName: it.item_name,
      quantity: Number(it.quantity), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
    })),
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/quotations', validate('query', listQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('quotations').select(QUOTATION_SELECT).order('created_at', { ascending: false });
  const { search, status, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`quotation_number.ilike.%${search}%,customer_name.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(quotationFromRow));
});

app.get('/api/quotations/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('quotations').select(QUOTATION_DETAIL_SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(quotationWithItemsFromRow(data));
});

// Wraps create_quotation() — atomic header + items insert, so an editable
// multi-item document never risks an orphaned header row from a partial
// client-side sequence.
app.post('/api/quotations', validate('json', saveBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('create_quotation', {
    p_customer_id: b.customerId,
    p_customer_name: b.customerName,
    p_status: b.status ?? 'draft',
    p_issue_date: b.issueDate,
    p_expiry_date: b.expiryDate || null,
    p_subtotal: b.subtotal,
    p_discount: b.discount ?? 0,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
    p_notes: b.notes || null,
    p_branch_id: b.branchId || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ quotationId: data.quotationId, quotationNumber: data.quotationNumber }, 201);
});

app.patch('/api/quotations/:id', validate('param', uuidParam), validate('json', saveBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.rpc('update_quotation', {
    p_quotation_id: c.req.valid('param').id,
    p_customer_id: b.customerId,
    p_customer_name: b.customerName,
    p_status: b.status ?? null,
    p_issue_date: b.issueDate,
    p_expiry_date: b.expiryDate || null,
    p_subtotal: b.subtotal,
    p_discount: b.discount ?? 0,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
    p_notes: b.notes || null,
    p_branch_id: b.branchId || null,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Thin single-table transition (draft -> sent -> accepted/rejected, or a
// manual expiry) — no item changes involved, so no RPC needed.
app.patch('/api/quotations/:id/status', validate('param', uuidParam), validate('json', statusBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('quotations')
    .update({ status: c.req.valid('json').status, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(QUOTATION_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(quotationFromRow(data));
});

app.delete('/api/quotations', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('quotations').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps convert_quotation_to_order() — the sole point a quotation is allowed
// to produce a real order/invoice/payment/stock movement. Always an explicit
// action; never triggered by any other quotation route.
app.post('/api/quotations/:id/convert', validate('param', uuidParam), validate('json', convertBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('convert_quotation_to_order', {
    p_quotation_id: c.req.valid('param').id,
    p_payment_method: b.paymentMethod,
    p_branch_id: b.branchId || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ orderId: data.orderId, invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber, branchId: data.branchId }, 201);
});

app.get('/api/organization/quotation-settings', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('organization_quotation_settings')
    .select(QUOTATION_SETTINGS_SELECT)
    .eq('organization_id', auth.organizationId)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  return c.json(quotationSettingsFromRow(data));
});

app.patch('/api/organization/quotation-settings', validate('json', quotationSettingsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.from('organization_quotation_settings').upsert(
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

// Aggregates everything a printable quotation needs — org name for the
// letterhead, the quotation's own real line items (unlike invoices,
// quotations always have their own), and best-effort settings.
app.get('/api/quotations/:id/print', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('quotations')
    .select(`${QUOTATION_DETAIL_SELECT}, organizations(name)`)
    .eq('id', c.req.valid('param').id)
    .single();
  if (error) return sendPgError(c, error);

  const row = data as any;
  const quotation = quotationWithItemsFromRow(row);

  const { data: settingsRow } = await auth.client
    .from('organization_quotation_settings')
    .select(QUOTATION_SETTINGS_SELECT)
    .eq('organization_id', row.organization_id)
    .maybeSingle();

  return c.json({
    quotation,
    organizationName: row.organizations?.name ?? '',
    lineItems: quotation.items.map((it) => ({ name: it.itemName, quantity: it.quantity, unitPrice: it.unitPrice, lineTotal: it.lineTotal })),
    quotationSettings: quotationSettingsFromRow(settingsRow),
  });
});

// Relays an already-rendered quotation to a customer via Resend — same
// pattern as /api/invoices/:id/email (reuses the same generic sender since
// nothing about it is invoice-specific).
app.post('/api/quotations/:id/email', validate('param', uuidParam), validate('json', emailQuotationBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('quotations')
    .select('quotation_number, organizations(name)')
    .eq('id', c.req.valid('param').id)
    .single();
  if (error) return sendPgError(c, error);

  const row = data as any;
  const b = c.req.valid('json');
  const subject = b.subject || `Quotation ${row.quotation_number} from ${row.organizations?.name ?? 'your supplier'}`;

  try {
    await sendInvoiceEmail(c.env, { to: b.to, subject, html: b.html });
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Failed to send quotation email.' }, 502);
  }
  return c.body(null, 204);
});

export default app;
