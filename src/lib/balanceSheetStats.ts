import type { Context } from 'hono';
import type { Bindings } from './supabase.js';
import type { AuthResult } from './auth.js';
import { sendPgError } from './errors.js';
import { dateKey } from './periodStats.js';

// Tolerance for the balance-check display — avoids flagging a "not balanced"
// state over floating-point noise from summing many rows.
const BALANCE_EPSILON = 0.01;

export interface BalanceSheetLedgerLine {
  id: string;
  name: string;
  amount: number;
}

export interface BalanceSheetStats {
  assets: {
    bank: number;
    cash: number;
    receivables: number;
    ledgers: BalanceSheetLedgerLine[];
    total: number;
  };
  liabilities: {
    payables: number;
    taxesPayable: number;
    ledgers: BalanceSheetLedgerLine[];
    total: number;
  };
  equity: {
    retainedEarnings: number;
    ledgers: BalanceSheetLedgerLine[];
    total: number;
  };
  balanceCheck: {
    assetsTotal: number;
    liabilitiesPlusEquityTotal: number;
    difference: number;
    balanced: boolean;
  };
}

// A point-in-time snapshot (not range-scoped like /api/reports/finance) —
// every figure is "as of" a single date, cumulative since inception.
//
// Two known approximations, inherent to reusing today's single-entry tables
// rather than a real transaction ledger (documented here, not fixed — out
// of scope for the "categorize + report" approach this was built under):
//
// 1. Bank/Cash are always "as of now" regardless of `asOf`. bank_accounts/
//    cash_registers only store a running current_balance, not a balance
//    history. bank_transactions *could* reconstruct a bank account's past
//    balance (it has occurred_at), but cash registers have no equivalent
//    transaction log at all — reconstructing one but not the other would be
//    inconsistent, so both stay "live now" for any asOf.
// 2. A past `asOf` is a best-effort filter on `created_at`/current status,
//    not a true historical reconstruction — there's no status-change
//    history table, so e.g. an invoice created before `asOf` but paid after
//    it is excluded from Receivables even though it was genuinely
//    outstanding on that date. Exact for asOf = today (the default);
//    approximate for any earlier date.
// 3. Ordinary POS revenue (complete_order()/confirm_booking() create
//    invoices already status='paid') never posts to bank_accounts/
//    cash_registers — only record_payment() does, and only when the caller
//    supplies a bank/cash account. So Assets will commonly run behind
//    Liabilities + Equity by roughly that untracked revenue; this is a
//    pre-existing gap, not a bug in this computation, and the UI should
//    present balanceCheck.balanced === false as informational, not an error.
export async function computeBalanceSheet(
  c: Context<{ Bindings: Bindings }>,
  auth: AuthResult,
  asOf: Date
): Promise<BalanceSheetStats | Response> {
  const asOfExclusive = new Date(asOf);
  asOfExclusive.setDate(asOfExclusive.getDate() + 1);
  const asOfExclusiveIso = asOfExclusive.toISOString();
  const asOfKey = dateKey(asOf);

  const [
    bankRes,
    cashRes,
    paidInvoicesRes,
    outstandingInvoicesRes,
    paidBillsRes,
    outstandingBillsRes,
    ledgersRes,
    entriesRes,
  ] = await Promise.all([
    auth.client.from('bank_accounts').select('current_balance').eq('status', 'active'),
    auth.client.from('cash_registers').select('current_balance').eq('status', 'active'),
    auth.client.from('invoices').select('total, tax').eq('status', 'paid').lt('created_at', asOfExclusiveIso),
    auth.client.from('invoices').select('total, amount_paid').neq('status', 'void').neq('status', 'refunded').lt('created_at', asOfExclusiveIso),
    auth.client.from('bills').select('total, tax').eq('status', 'paid').lt('created_at', asOfExclusiveIso),
    auth.client.from('bills').select('total, amount_paid').neq('status', 'void').lt('created_at', asOfExclusiveIso),
    auth.client.from('ledgers').select('id, name, account_type'),
    auth.client.from('ledger_entries').select('ledger_id, direction, amount').lte('entry_date', asOfKey),
  ]);
  for (const res of [bankRes, cashRes, paidInvoicesRes, outstandingInvoicesRes, paidBillsRes, outstandingBillsRes, ledgersRes, entriesRes]) {
    if (res.error) return sendPgError(c, res.error);
  }

  const bank = (bankRes.data ?? []).reduce((sum, a: any) => sum + Number(a.current_balance), 0);
  const cash = (cashRes.data ?? []).reduce((sum, r: any) => sum + Number(r.current_balance), 0);
  // Outstanding AR/AP include partially-paid rows (status not yet 'paid')
  // and exclude cancelled ones — same predicate periodStats.ts already uses
  // for the Dashboard's outstandingAR KPI.
  const receivables = (outstandingInvoicesRes.data ?? []).reduce((sum, i: any) => sum + (Number(i.total) - Number(i.amount_paid)), 0);
  const payables = (outstandingBillsRes.data ?? []).reduce((sum, b: any) => sum + (Number(b.total) - Number(b.amount_paid)), 0);

  const allTimeRevenue = (paidInvoicesRes.data ?? []).reduce((sum, i: any) => sum + Number(i.total), 0);
  const allTimeExpenses = (paidBillsRes.data ?? []).reduce((sum, b: any) => sum + Number(b.total), 0);
  const taxCollected = (paidInvoicesRes.data ?? []).reduce((sum, i: any) => sum + Number(i.tax), 0);
  const taxPaid = (paidBillsRes.data ?? []).reduce((sum, b: any) => sum + Number(b.tax), 0);
  const taxesPayable = taxCollected - taxPaid;

  // net = credit (money in) - debit (money out), same convention
  // /api/ledgers and /api/reports/finance already use for ledger totals.
  const netByLedger = new Map<string, number>();
  (entriesRes.data ?? []).forEach((e: any) => {
    const delta = e.direction === 'credit' ? Number(e.amount) : -Number(e.amount);
    netByLedger.set(e.ledger_id, (netByLedger.get(e.ledger_id) ?? 0) + delta);
  });
  const ledgersByType = (type: string): BalanceSheetLedgerLine[] =>
    (ledgersRes.data ?? [])
      .filter((l: any) => l.account_type === type)
      .map((l: any) => ({ id: l.id, name: l.name, amount: netByLedger.get(l.id) ?? 0 }));

  const assetLedgers = ledgersByType('asset');
  const liabilityLedgers = ledgersByType('liability');
  const equityLedgers = ledgersByType('equity');
  const incomeLedgersNet = ledgersByType('income').reduce((sum, l) => sum + l.amount, 0);
  const expenseLedgersNet = ledgersByType('expense').reduce((sum, l) => sum + l.amount, 0);

  const assetsTotal = bank + cash + receivables + assetLedgers.reduce((sum, l) => sum + l.amount, 0);
  const liabilitiesTotal = payables + taxesPayable + liabilityLedgers.reduce((sum, l) => sum + l.amount, 0);
  // Cumulative net income, all-time up to asOf — the same "income/expense
  // ledgers fold in" rule the Income Statement uses, just unbounded by a
  // from/to window instead of one period.
  const retainedEarnings = allTimeRevenue - allTimeExpenses + incomeLedgersNet + expenseLedgersNet;
  const equityTotal = retainedEarnings + equityLedgers.reduce((sum, l) => sum + l.amount, 0);

  const liabilitiesPlusEquityTotal = liabilitiesTotal + equityTotal;
  const difference = assetsTotal - liabilitiesPlusEquityTotal;

  return {
    assets: { bank, cash, receivables, ledgers: assetLedgers, total: assetsTotal },
    liabilities: { payables, taxesPayable, ledgers: liabilityLedgers, total: liabilitiesTotal },
    equity: { retainedEarnings, ledgers: equityLedgers, total: equityTotal },
    balanceCheck: {
      assetsTotal,
      liabilitiesPlusEquityTotal,
      difference,
      balanced: Math.abs(difference) < BALANCE_EPSILON,
    },
  };
}
