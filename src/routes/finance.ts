import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

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
  tax: z.number(),
  notes: z.string().optional().nullable(),
});

const recordPaymentBody = z.object({
  amount: z.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  notes: z.string().optional().nullable(),
});

const INVOICE_SELECT = 'id, organization_id, order_id, customer_id, customer_name, invoice_number, status, issue_date, due_date, subtotal, tax, total, amount_paid, notes, created_at';

function invoiceFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, orderId: row.order_id, customerId: row.customer_id,
    customerName: row.customer_name, invoiceNumber: row.invoice_number, status: row.status,
    issueDate: row.issue_date, dueDate: row.due_date, subtotal: Number(row.subtotal), tax: Number(row.tax),
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
      status: b.status, issue_date: b.issueDate, due_date: b.dueDate, subtotal: b.subtotal, tax: b.tax,
      total: b.subtotal + b.tax, notes: b.notes || null, updated_at: new Date().toISOString(),
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

  return c.json({
    invoice: invoiceFromRow(row),
    organizationName: row.organizations?.name ?? '',
    lineItems,
    payments: (row.payments ?? []).map((p: any) => ({
      amount: Number(p.amount), method: p.method, paidAt: p.paid_at, notes: p.notes,
    })),
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
