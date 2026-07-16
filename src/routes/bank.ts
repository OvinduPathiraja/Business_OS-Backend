import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody, optionalDateRangeQuery } from '../lib/schemas.js';

const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
const TRANSFER_ACCOUNT_TYPES = ['bank_account', 'cash_register'] as const;
const TRANSACTION_DIRECTIONS = ['credit', 'debit'] as const;

const bankAccountCreateBody = z.object({
  name: z.string().trim().min(1),
  bankName: z.string().trim().optional().nullable(),
  accountNumberLast4: z.string().trim().max(4).optional().nullable(),
  openingBalance: z.number().optional().default(0),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});
const bankAccountUpdateBody = bankAccountCreateBody.omit({ openingBalance: true });

const cashRegisterCreateBody = z.object({
  name: z.string().trim().min(1),
  openingBalance: z.number().optional().default(0),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});
const cashRegisterUpdateBody = cashRegisterCreateBody.omit({ openingBalance: true });

const transferBody = z.object({
  fromType: z.enum(TRANSFER_ACCOUNT_TYPES),
  fromId: z.string().uuid(),
  toType: z.enum(TRANSFER_ACCOUNT_TYPES),
  toId: z.string().uuid(),
  amount: z.number().positive(),
  notes: z.string().optional().nullable(),
});

const manualTransactionBody = z.object({
  direction: z.enum(TRANSACTION_DIRECTIONS),
  amount: z.number().positive(),
  description: z.string().optional().nullable(),
  occurredAt: z.string().optional(),
});

const reconcileBody = z.object({ reconciled: z.boolean() });

const BANK_ACCOUNT_SELECT = 'id, organization_id, name, bank_name, account_number_last4, opening_balance, current_balance, status, created_at';
const CASH_REGISTER_SELECT = 'id, organization_id, name, opening_balance, current_balance, status, created_at';
const TRANSFER_SELECT = 'id, organization_id, from_type, from_bank_account_id, from_cash_register_id, to_type, to_bank_account_id, to_cash_register_id, amount, notes, transferred_at, created_by, created_at';
const TRANSACTION_SELECT = 'id, organization_id, bank_account_id, direction, amount, source, reference_id, description, occurred_at, reconciled, reconciled_at, reconciled_by, created_at';

function bankAccountFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, bankName: row.bank_name,
    accountNumberLast4: row.account_number_last4, openingBalance: Number(row.opening_balance),
    currentBalance: Number(row.current_balance), status: row.status, createdAt: row.created_at,
  };
}

function cashRegisterFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, openingBalance: Number(row.opening_balance),
    currentBalance: Number(row.current_balance), status: row.status, createdAt: row.created_at,
  };
}

function transferFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, fromType: row.from_type,
    fromBankAccountId: row.from_bank_account_id, fromCashRegisterId: row.from_cash_register_id,
    toType: row.to_type, toBankAccountId: row.to_bank_account_id, toCashRegisterId: row.to_cash_register_id,
    amount: Number(row.amount), notes: row.notes, transferredAt: row.transferred_at,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

function transactionFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, bankAccountId: row.bank_account_id, direction: row.direction,
    amount: Number(row.amount), source: row.source, referenceId: row.reference_id, description: row.description,
    occurredAt: row.occurred_at, reconciled: row.reconciled, reconciledAt: row.reconciled_at,
    reconciledBy: row.reconciled_by, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/bank-accounts', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('bank_accounts').select(BANK_ACCOUNT_SELECT).order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(bankAccountFromRow));
});

app.post('/api/bank-accounts', validate('json', bankAccountCreateBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bank_accounts')
    .insert({
      organization_id: auth.organizationId, name: b.name, bank_name: b.bankName || null,
      account_number_last4: b.accountNumberLast4 || null, opening_balance: b.openingBalance,
      current_balance: b.openingBalance, status: b.status ?? 'active',
    })
    .select(BANK_ACCOUNT_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(bankAccountFromRow(data), 201);
});

app.patch('/api/bank-accounts/:id', validate('param', uuidParam), validate('json', bankAccountUpdateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bank_accounts')
    .update({
      name: b.name, bank_name: b.bankName || null, account_number_last4: b.accountNumberLast4 || null,
      status: b.status, updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(BANK_ACCOUNT_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(bankAccountFromRow(data));
});

app.delete('/api/bank-accounts', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('bank_accounts').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/cash-registers', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('cash_registers').select(CASH_REGISTER_SELECT).order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(cashRegisterFromRow));
});

app.post('/api/cash-registers', validate('json', cashRegisterCreateBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('cash_registers')
    .insert({
      organization_id: auth.organizationId, name: b.name,
      opening_balance: b.openingBalance, current_balance: b.openingBalance, status: b.status ?? 'active',
    })
    .select(CASH_REGISTER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(cashRegisterFromRow(data), 201);
});

app.patch('/api/cash-registers/:id', validate('param', uuidParam), validate('json', cashRegisterUpdateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('cash_registers')
    .update({ name: b.name, status: b.status, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(CASH_REGISTER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(cashRegisterFromRow(data));
});

app.delete('/api/cash-registers', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('cash_registers').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/fund-transfers', validate('query', paginationQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { limit, offset } = c.req.valid('query');
  const { data, error } = await auth.client
    .from('fund_transfers')
    .select(TRANSFER_SELECT)
    .order('transferred_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(transferFromRow));
});

// Wraps the transfer_funds() RPC — moves money between any combination of a
// bank account and a cash register (e.g. depositing cash-register takings
// into the bank), gated on bank.add.
app.post('/api/fund-transfers', validate('json', transferBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('transfer_funds', {
    p_from_type: b.fromType, p_from_id: b.fromId, p_to_type: b.toType, p_to_id: b.toId,
    p_amount: b.amount, p_notes: b.notes || null,
  });
  if (error) return sendPgError(c, error);
  return c.json({ transferId: data.transferId }, 201);
});

app.get('/api/bank-accounts/:id/transactions', validate('param', uuidParam), validate('query', optionalDateRangeQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  let query = auth.client.from('bank_transactions').select(TRANSACTION_SELECT)
    .eq('bank_account_id', c.req.valid('param').id)
    .order('occurred_at', { ascending: false });
  if (from) query = query.gte('occurred_at', from);
  if (to) query = query.lte('occurred_at', `${to}T23:59:59`);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(transactionFromRow));
});

// Wraps the record_bank_transaction() RPC — manual ledger entries (bank
// fees, interest) that don't originate from a payment or transfer, gated on
// bank.add.
app.post('/api/bank-accounts/:id/transactions', validate('param', uuidParam), validate('json', manualTransactionBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('record_bank_transaction', {
    p_bank_account_id: c.req.valid('param').id,
    p_direction: b.direction,
    p_amount: b.amount,
    p_description: b.description || null,
    ...(b.occurredAt ? { p_occurred_at: b.occurredAt } : {}),
  });
  if (error) return sendPgError(c, error);
  return c.json({ transactionId: data.transactionId }, 201);
});

// Manual reconciliation toggle — a plain RLS-gated update, not an RPC (no
// balance math, just a flag), matching invoices' PATCH route.
app.patch('/api/bank-transactions/:id', validate('param', uuidParam), validate('json', reconcileBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { reconciled } = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bank_transactions')
    .update({
      reconciled,
      reconciled_at: reconciled ? new Date().toISOString() : null,
      reconciled_by: reconciled ? auth.userId : null,
    })
    .eq('id', c.req.valid('param').id)
    .select(TRANSACTION_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(transactionFromRow(data));
});

export default app;
