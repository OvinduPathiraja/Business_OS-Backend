import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { MAX_RANGE_DAYS, computePeriodStats, dateKey, parseDateKey, rangeDays, resolveRange } from '../lib/periodStats.js';
import { computeCashFlowStats } from '../lib/cashFlowStats.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const reportsQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
}).refine((q) => (q.from == null) === (q.to == null), { message: 'from and to must be provided together' })
  .refine((q) => !q.from || !q.to || parseDateKey(q.from) <= parseDateKey(q.to), { message: 'from must not be after to' })
  .refine((q) => !q.from || !q.to || rangeDays({ from: parseDateKey(q.from), to: parseDateKey(q.to) }) <= MAX_RANGE_DAYS, {
    message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
  });

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/reports', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 30);
  const stats = await computePeriodStats(c, auth, range);
  if (stats instanceof Response) return stats;

  return c.json({ from: dateKey(range.from), to: dateKey(range.to), ...stats });
});

// Revenue (paid invoices) minus expenses (paid bills, grouped by category)
// over the range. No general ledger/chart of accounts — this is a direct
// aggregation over invoices/bills, matching the confirmed reporting scope.
app.get('/api/reports/pnl', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 30);
  const toExclusive = new Date(range.to);
  toExclusive.setDate(toExclusive.getDate() + 1);
  const fromIso = range.from.toISOString();
  const toExclusiveIso = toExclusive.toISOString();

  const [revenueRes, expensesRes] = await Promise.all([
    auth.client.from('invoices').select('total, created_at').eq('status', 'paid').gte('created_at', fromIso).lt('created_at', toExclusiveIso),
    auth.client.from('bills').select('total, category, created_at').eq('status', 'paid').gte('created_at', fromIso).lt('created_at', toExclusiveIso),
  ]);
  if (revenueRes.error) return sendPgError(c, revenueRes.error);
  if (expensesRes.error) return sendPgError(c, expensesRes.error);

  const revenue = (revenueRes.data ?? []).reduce((sum, i: any) => sum + Number(i.total), 0);

  const expensesByCategory = new Map<string, number>();
  (expensesRes.data ?? []).forEach((b: any) => {
    expensesByCategory.set(b.category, (expensesByCategory.get(b.category) ?? 0) + Number(b.total));
  });
  const expenseBreakdown = Array.from(expensesByCategory.entries()).map(([category, amount]) => ({ category, amount }));
  const totalExpenses = expenseBreakdown.reduce((sum, e) => sum + e.amount, 0);

  return c.json({
    from: dateKey(range.from),
    to: dateKey(range.to),
    revenue,
    totalExpenses,
    netProfit: revenue - totalExpenses,
    expenseBreakdown,
  });
});

// One combined statement for the Finance hub's Report sub-section: revenue vs
// expenses (P&L shape), tax collected/paid, current bank/cash balances, and
// per-ledger money in/out for the org's custom ledgers, all over one selected
// period. Each block is scoped by its own RLS policy — a viewer without e.g.
// bank.view just gets zeros for the bank block rather than an error.
app.get('/api/reports/finance', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 30);
  const toExclusive = new Date(range.to);
  toExclusive.setDate(toExclusive.getDate() + 1);
  const fromIso = range.from.toISOString();
  const toExclusiveIso = toExclusive.toISOString();
  const fromKey = dateKey(range.from);
  const toKey = dateKey(range.to);

  const [revenueRes, expensesRes, ledgersRes, entriesRes, bankRes, cashRes] = await Promise.all([
    auth.client.from('invoices').select('total, tax, created_at').eq('status', 'paid').gte('created_at', fromIso).lt('created_at', toExclusiveIso),
    auth.client.from('bills').select('total, tax, category, created_at').eq('status', 'paid').gte('created_at', fromIso).lt('created_at', toExclusiveIso),
    auth.client.from('ledgers').select('id, name'),
    auth.client.from('ledger_entries').select('ledger_id, direction, amount, entry_date').gte('entry_date', fromKey).lte('entry_date', toKey),
    auth.client.from('bank_accounts').select('current_balance').eq('status', 'active'),
    auth.client.from('cash_registers').select('current_balance').eq('status', 'active'),
  ]);
  for (const res of [revenueRes, expensesRes, ledgersRes, entriesRes, bankRes, cashRes]) {
    if (res.error) return sendPgError(c, res.error);
  }

  const revenue = (revenueRes.data ?? []).reduce((sum, i: any) => sum + Number(i.total), 0);
  const taxCollected = (revenueRes.data ?? []).reduce((sum, i: any) => sum + Number(i.tax), 0);
  const taxPaid = (expensesRes.data ?? []).reduce((sum, b: any) => sum + Number(b.tax), 0);

  const expensesByCategory = new Map<string, number>();
  (expensesRes.data ?? []).forEach((b: any) => {
    expensesByCategory.set(b.category, (expensesByCategory.get(b.category) ?? 0) + Number(b.total));
  });
  const expenseBreakdown = Array.from(expensesByCategory.entries()).map(([category, amount]) => ({ category, amount }));
  const totalExpenses = expenseBreakdown.reduce((sum, e) => sum + e.amount, 0);

  const ledgerTotals = new Map<string, { moneyIn: number; moneyOut: number }>();
  (entriesRes.data ?? []).forEach((e: any) => {
    const t = ledgerTotals.get(e.ledger_id) ?? { moneyIn: 0, moneyOut: 0 };
    if (e.direction === 'credit') t.moneyIn += Number(e.amount);
    else t.moneyOut += Number(e.amount);
    ledgerTotals.set(e.ledger_id, t);
  });
  const ledgers = (ledgersRes.data ?? []).map((l: any) => {
    const t = ledgerTotals.get(l.id) ?? { moneyIn: 0, moneyOut: 0 };
    return { id: l.id, name: l.name, moneyIn: t.moneyIn, moneyOut: t.moneyOut, net: t.moneyIn - t.moneyOut };
  });

  const bankBalance = (bankRes.data ?? []).reduce((sum, a: any) => sum + Number(a.current_balance), 0);
  const cashBalance = (cashRes.data ?? []).reduce((sum, r: any) => sum + Number(r.current_balance), 0);

  return c.json({
    from: fromKey,
    to: toKey,
    revenue,
    totalExpenses,
    netProfit: revenue - totalExpenses,
    expenseBreakdown,
    taxCollected,
    taxPaid,
    taxNet: taxCollected - taxPaid,
    bankBalance,
    cashBalance,
    ledgers,
  });
});

app.get('/api/reports/cash-flow', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 30);
  const stats = await computeCashFlowStats(c, auth, range);
  if (stats instanceof Response) return stats;

  return c.json({ from: dateKey(range.from), to: dateKey(range.to), ...stats });
});

export default app;
