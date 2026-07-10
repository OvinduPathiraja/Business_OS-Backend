import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
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

export default async function financeRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get('/api/invoices', { schema: { querystring: listQuery } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    let query = auth.client.from('invoices').select(INVOICE_SELECT).order('created_at', { ascending: false });
    const { search, status, limit, offset } = request.query;
    if (search) query = query.or(`invoice_number.ilike.%${search}%,customer_name.ilike.%${search}%`);
    if (status) query = query.eq('status', status);
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) return sendPgError(reply, error);
    reply.send((data ?? []).map(invoiceFromRow));
  });

  server.patch('/api/invoices/:id', { schema: { params: uuidParam, body: updateBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const b = request.body;
    const { data, error } = await auth.client
      .from('invoices')
      .update({
        customer_id: b.customerId, customer_name: b.customerName, invoice_number: b.invoiceNumber,
        status: b.status, issue_date: b.issueDate, due_date: b.dueDate, subtotal: b.subtotal, tax: b.tax,
        total: b.subtotal + b.tax, notes: b.notes || null, updated_at: new Date().toISOString(),
      })
      .eq('id', request.params.id)
      .select(INVOICE_SELECT)
      .single();
    if (error) return sendPgError(reply, error);
    reply.send(invoiceFromRow(data));
  });

  server.delete('/api/invoices', { schema: { body: bulkIdsBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { error } = await auth.client.from('invoices').delete().in('id', request.body.ids);
    if (error) return sendPgError(reply, error);
    reply.code(204).send();
  });

  server.get('/api/invoices/:id/payments', { schema: { params: uuidParam } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('payments')
      .select('id, invoice_id, amount, method, paid_at, notes')
      .eq('invoice_id', request.params.id)
      .order('paid_at', { ascending: false });
    if (error) return sendPgError(reply, error);
    reply.send((data ?? []).map((r: any) => ({
      id: r.id, invoiceId: r.invoice_id, amount: Number(r.amount), method: r.method, paidAt: r.paid_at, notes: r.notes,
    })));
  });

  // Wraps the new record_payment() RPC (added in
  // supabase/migrations/20260710120000_transactional_write_rpcs.sql) —
  // locks the invoice row (SELECT ... FOR UPDATE) so two concurrent
  // payments can't both read a stale amount_paid, and is gated on
  // finance.update (owner/admin), matching add_finance.sql's original
  // documented intent that editing existing records is owner/admin-only.
  // This is a disclosed, intentional behavior change — see ROADMAP.
  server.post('/api/invoices/:id/payments', { schema: { params: uuidParam, body: recordPaymentBody } }, async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client.rpc('record_payment', {
      p_invoice_id: request.params.id,
      p_amount: request.body.amount,
      p_method: request.body.method,
      p_notes: request.body.notes || null,
    });
    if (error) return sendPgError(reply, error);
    reply.code(201).send({ amountPaid: data.amountPaid, status: data.status });
  });
}
