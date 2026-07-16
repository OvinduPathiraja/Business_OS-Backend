import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const BILL_STATUSES = ['draft', 'pending_approval', 'approved', 'paid', 'void'] as const;
const BILL_CATEGORIES = ['procurement', 'salaries', 'utilities', 'maintenance', 'marketing', 'operational', 'other'] as const;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

const listQuery = paginationQuery.extend({
  status: z.enum(BILL_STATUSES).optional(),
  category: z.enum(BILL_CATEGORIES).optional(),
  vendorId: z.string().uuid().optional(),
});

const createBody = z.object({
  vendorId: z.string().uuid().nullable(),
  vendorName: z.string().trim().min(1),
  billNumber: z.string().trim().min(1),
  category: z.enum(BILL_CATEGORIES),
  employeeId: z.string().uuid().optional().nullable(),
  status: z.enum(['draft', 'pending_approval']).optional().default('draft'),
  issueDate: z.string(),
  dueDate: z.string().optional().nullable(),
  subtotal: z.number(),
  tax: z.number(),
  taxCodeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const updateBody = createBody.omit({ status: true }).extend({
  status: z.enum(BILL_STATUSES).optional(),
});

const recordPaymentBody = z.object({
  amount: z.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  bankAccountId: z.string().uuid().optional().nullable(),
  cashRegisterId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const quickExpenseBody = z.object({
  vendorId: z.string().uuid().optional().nullable(),
  vendorName: z.string().trim().optional().default(''),
  category: z.enum(BILL_CATEGORIES),
  amount: z.number().positive(),
  tax: z.number().min(0).optional().default(0),
  method: z.enum(PAYMENT_METHODS),
  bankAccountId: z.string().uuid().optional().nullable(),
  cashRegisterId: z.string().uuid().optional().nullable(),
  employeeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  expenseDate: z.string().optional(),
});

const BILL_SELECT = 'id, organization_id, vendor_id, vendor_name, bill_number, category, employee_id, status, issue_date, due_date, subtotal, tax, total, amount_paid, tax_code_id, notes, approved_by, approved_at, created_at';

function billFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, vendorId: row.vendor_id, vendorName: row.vendor_name,
    billNumber: row.bill_number, category: row.category, employeeId: row.employee_id, status: row.status,
    issueDate: row.issue_date, dueDate: row.due_date, subtotal: Number(row.subtotal), tax: Number(row.tax),
    total: Number(row.total), amountPaid: Number(row.amount_paid), taxCodeId: row.tax_code_id, notes: row.notes,
    approvedBy: row.approved_by, approvedAt: row.approved_at, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/bills', validate('query', listQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  let query = auth.client.from('bills').select(BILL_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
  const { search, status, category, vendorId, limit, offset } = c.req.valid('query');
  if (search) query = query.or(`bill_number.ilike.%${search}%,vendor_name.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  if (vendorId) query = query.eq('vendor_id', vendorId);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(billFromRow));
});

app.get('/api/bills/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('bills').select(BILL_SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(billFromRow(data));
});

app.post('/api/bills', validate('json', createBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bills')
    .insert({
      organization_id: auth.organizationId,
      vendor_id: b.vendorId, vendor_name: b.vendorName, bill_number: b.billNumber, category: b.category,
      employee_id: b.employeeId || null, status: b.status, issue_date: b.issueDate, due_date: b.dueDate || null,
      subtotal: b.subtotal, tax: b.tax, total: b.subtotal + b.tax, tax_code_id: b.taxCodeId || null, notes: b.notes || null,
    })
    .select(BILL_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(billFromRow(data), 201);
});

app.patch('/api/bills/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bills')
    .update({
      vendor_id: b.vendorId, vendor_name: b.vendorName, bill_number: b.billNumber, category: b.category,
      employee_id: b.employeeId || null, ...(b.status ? { status: b.status } : {}),
      issue_date: b.issueDate, due_date: b.dueDate || null, subtotal: b.subtotal, tax: b.tax,
      total: b.subtotal + b.tax, tax_code_id: b.taxCodeId || null, notes: b.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(BILL_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(billFromRow(data));
});

app.delete('/api/bills', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('bills').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps the approve_bill() RPC — row-locks the bill and flips
// pending_approval -> approved, gated on payables.update.
app.post('/api/bills/:id/approve', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('approve_bill', { p_bill_id: c.req.valid('param').id });
  if (error) return sendPgError(c, error);
  return c.json({ status: data.status });
});

app.get('/api/bills/:id/payments', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('bill_payments')
    .select('id, bill_id, amount, method, bank_account_id, cash_register_id, paid_at, notes')
    .eq('bill_id', c.req.valid('param').id)
    .order('paid_at', { ascending: false });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map((r: any) => ({
    id: r.id, billId: r.bill_id, amount: Number(r.amount), method: r.method,
    bankAccountId: r.bank_account_id, cashRegisterId: r.cash_register_id, paidAt: r.paid_at, notes: r.notes,
  })));
});

// Wraps the record_bill_payment() RPC — locks the bill row, optionally
// decrements a bank account or cash register balance and logs a ledger
// entry, gated on payables.update.
app.post('/api/bills/:id/payments', validate('param', uuidParam), validate('json', recordPaymentBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client.rpc('record_bill_payment', {
    p_bill_id: c.req.valid('param').id,
    p_amount: body.amount,
    p_method: body.method,
    p_bank_account_id: body.bankAccountId || null,
    p_cash_register_id: body.cashRegisterId || null,
    p_notes: body.notes || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ amountPaid: data.amountPaid, status: data.status }, 201);
});

// Wraps the create_quick_expense() RPC — the one-off "log a paid expense
// now" path: creates an already-paid bill plus its payment/ledger rows in a
// single atomic call, gated on payables.add.
app.post('/api/expenses', validate('json', quickExpenseBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('create_quick_expense', {
    p_vendor_name: b.vendorName,
    p_category: b.category,
    p_amount: b.amount,
    p_method: b.method,
    p_vendor_id: b.vendorId || null,
    p_tax: b.tax,
    p_bank_account_id: b.bankAccountId || null,
    p_cash_register_id: b.cashRegisterId || null,
    p_employee_id: b.employeeId || null,
    p_notes: b.notes || null,
    ...(b.expenseDate ? { p_expense_date: b.expenseDate } : {}),
  });
  if (error) return sendPgError(c, error);
  return c.json({ billId: data.billId, billNumber: data.billNumber, status: data.status }, 201);
});

export default app;
