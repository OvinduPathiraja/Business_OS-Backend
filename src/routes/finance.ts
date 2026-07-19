import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
import { invoiceTemplateSchema } from '../lib/invoiceTemplateSchema.js';

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void', 'refunded'] as const;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

const listQuery = paginationQuery.extend({ status: z.enum(INVOICE_STATUSES).optional() });

const updateBody = z.object({
  customerId: z.string().uuid().nullable(),
  customerName: z.string().trim().min(1),
  invoiceNumber: z.string().trim().min(1),
  status: z.enum(INVOICE_STATUSES),
  issueDate: z.string(),
  dueDate: z.string(),
  subtotal: z.number(),
  discount: z.number().min(0).optional(),
  tax: z.number(),
  notes: z.string().optional().nullable(),
});

const recordPaymentBody = z.object({
  amount: z.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  notes: z.string().optional().nullable(),
});

const invoiceSettingsBody = z.object({
  logoUrl: z.string().trim().max(2048).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().max(255).optional().nullable(),
  accentColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  footerText: z.string().trim().max(1000).optional().nullable(),
  termsText: z.string().trim().max(2000).optional().nullable(),
  showTax: z.boolean().optional(),
  showDueDate: z.boolean().optional(),
  showPaymentHistory: z.boolean().optional(),
  template: invoiceTemplateSchema.optional().nullable(),
});

const INVOICE_SETTINGS_SELECT = 'logo_url, address, phone, email, accent_color, footer_text, terms_text, show_tax, show_due_date, show_payment_history, template';

function invoiceSettingsFromRow(row: any) {
  return {
    logoUrl: row?.logo_url ?? null,
    address: row?.address ?? null,
    phone: row?.phone ?? null,
    email: row?.email ?? null,
    accentColor: row?.accent_color ?? '#1A1D23',
    footerText: row?.footer_text ?? null,
    termsText: row?.terms_text ?? null,
    showTax: row?.show_tax ?? true,
    showDueDate: row?.show_due_date ?? true,
    showPaymentHistory: row?.show_payment_history ?? true,
    template: row?.template ?? null,
  };
}

const INVOICE_SELECT = 'id, organization_id, order_id, customer_id, customer_name, invoice_number, status, issue_date, due_date, subtotal, discount, tax, total, amount_paid, notes, created_at';

function invoiceFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, orderId: row.order_id, customerId: row.customer_id,
    customerName: row.customer_name, invoiceNumber: row.invoice_number, status: row.status,
    issueDate: row.issue_date, dueDate: row.due_date, subtotal: Number(row.subtotal),
    discount: Number(row.discount ?? 0), tax: Number(row.tax),
    total: Number(row.total), amountPaid: Number(row.amount_paid), notes: row.notes, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/invoices', validate('query', listQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('invoices').select(INVOICE_SELECT).order('created_at', { ascending: false });
  const { search, status, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`invoice_number.ilike.%${search}%,customer_name.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(invoiceFromRow));
});

app.patch('/api/invoices/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('invoices')
    .update({
      customer_id: b.customerId, customer_name: b.customerName, invoice_number: b.invoiceNumber,
      status: b.status, issue_date: b.issueDate, due_date: b.dueDate, subtotal: b.subtotal,
      discount: b.discount ?? 0, tax: b.tax,
      total: b.subtotal - (b.discount ?? 0) + b.tax, notes: b.notes || null, updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(INVOICE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(invoiceFromRow(data));
});

app.delete('/api/invoices', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('invoices').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/organization/invoice-settings', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('organization_invoice_settings')
    .select(INVOICE_SETTINGS_SELECT)
    .eq('organization_id', auth.organizationId)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  return c.json(invoiceSettingsFromRow(data));
});

app.patch('/api/organization/invoice-settings', validate('json', invoiceSettingsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.from('organization_invoice_settings').upsert(
    {
      organization_id: auth.organizationId,
      ...(b.logoUrl !== undefined ? { logo_url: b.logoUrl || null } : {}),
      ...(b.address !== undefined ? { address: b.address || null } : {}),
      ...(b.phone !== undefined ? { phone: b.phone || null } : {}),
      ...(b.email !== undefined ? { email: b.email || null } : {}),
      ...(b.accentColor !== undefined ? { accent_color: b.accentColor } : {}),
      ...(b.footerText !== undefined ? { footer_text: b.footerText || null } : {}),
      ...(b.termsText !== undefined ? { terms_text: b.termsText || null } : {}),
      ...(b.showTax !== undefined ? { show_tax: b.showTax } : {}),
      ...(b.showDueDate !== undefined ? { show_due_date: b.showDueDate } : {}),
      ...(b.showPaymentHistory !== undefined ? { show_payment_history: b.showPaymentHistory } : {}),
      ...(b.template !== undefined ? { template: b.template } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' }
  );
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Aggregates everything a printable invoice needs in one PostgREST embedded
// select — org name for the letterhead, line items (via order_id for a
// walk-in sale), and payment history. invoices has no line items of its
// own; a booking-originated invoice (booking_id set instead of order_id,
// mutually exclusive per invoices_order_or_booking_check) has none to
// select at all, so its single line item is synthesized below from
// bookings.service_name + the invoice's own subtotal.
app.get('/api/invoices/:id/print', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('invoices')
    .select(
      `${INVOICE_SELECT}, organizations(name), ` +
      `orders(order_items(item_name, quantity, unit_price, line_total)), ` +
      `bookings(service_name), ` +
      `payments(amount, method, paid_at, notes)`
    )
    .eq('id', c.req.valid('param').id)
    .single();
  if (error) return sendPgError(c, error);

  const row = data as any;
  const orderItems: any[] = row.orders?.order_items ?? [];
  const lineItems = orderItems.length > 0
    ? orderItems.map((it) => ({
        name: it.item_name, quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
      }))
    : row.bookings
      ? [{ name: row.bookings.service_name, quantity: 1, unitPrice: Number(row.subtotal), lineTotal: Number(row.subtotal) }]
      : [];

  // Best-effort — a missing/RLS-blocked settings row just falls back to
  // invoiceSettingsFromRow(null)'s defaults rather than failing the print.
  const { data: settingsRow } = await auth.client
    .from('organization_invoice_settings')
    .select(INVOICE_SETTINGS_SELECT)
    .eq('organization_id', row.organization_id)
    .maybeSingle();

  return c.json({
    invoice: invoiceFromRow(row),
    organizationName: row.organizations?.name ?? '',
    lineItems,
    payments: (row.payments ?? []).map((p: any) => ({
      amount: Number(p.amount), method: p.method, paidAt: p.paid_at, notes: p.notes,
    })),
    invoiceSettings: invoiceSettingsFromRow(settingsRow),
  });
});

app.get('/api/invoices/:id/payments', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('payments')
    .select('id, invoice_id, amount, method, paid_at, notes')
    .eq('invoice_id', c.req.valid('param').id)
    .order('paid_at', { ascending: false });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map((r: any) => ({
    id: r.id, invoiceId: r.invoice_id, amount: Number(r.amount), method: r.method, paidAt: r.paid_at, notes: r.notes,
  })));
});

// Wraps the record_payment() RPC — locks the invoice row (SELECT ... FOR
// UPDATE) so two concurrent payments can't both read a stale amount_paid,
// and is gated on finance.update (owner/admin), matching add_finance.sql's
// original documented intent that editing existing records is owner/admin-
// only. This is a disclosed, intentional behavior change — see ROADMAP.
app.post('/api/invoices/:id/payments', validate('param', uuidParam), validate('json', recordPaymentBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client.rpc('record_payment', {
    p_invoice_id: c.req.valid('param').id,
    p_amount: body.amount,
    p_method: body.method,
    p_notes: body.notes || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ amountPaid: data.amountPaid, status: data.status }, 201);
});

export default app;
