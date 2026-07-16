import type { Context } from 'hono';
import type { Bindings } from './supabase.js';
import type { AuthResult } from './auth.js';
import { sendPgError } from './errors.js';
import { dateKey, rangeDays, type DateRange } from './periodStats.js';

export interface CashFlowStats {
  dailyCashIn: { key: string; amount: number }[];
  dailyCashOut: { key: string; amount: number }[];
  totalCashIn: number;
  totalCashOut: number;
  netCashFlow: number;
}

// Cash in = payments received against invoices; cash out = payments made
// against bills. Fund transfers between the business's own bank
// accounts/cash registers are deliberately excluded — moving money from the
// till to the bank isn't revenue or expense, it's a wash across the org's
// own accounts, so counting it here would misrepresent real cash flow.
export async function computeCashFlowStats(
  c: Context<{ Bindings: Bindings }>,
  auth: AuthResult,
  range: DateRange
): Promise<CashFlowStats | Response> {
  const { from, to } = range;
  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);
  const fromIso = from.toISOString();
  const toExclusiveIso = toExclusive.toISOString();
  const days = rangeDays(range);

  const [paymentsRes, billPaymentsRes] = await Promise.all([
    auth.client.from('payments').select('amount, paid_at').gte('paid_at', fromIso).lt('paid_at', toExclusiveIso),
    auth.client.from('bill_payments').select('amount, paid_at').gte('paid_at', fromIso).lt('paid_at', toExclusiveIso),
  ]);

  for (const res of [paymentsRes, billPaymentsRes]) {
    if (res.error) return sendPgError(c, res.error);
  }

  const cashInByDay = new Map<string, number>();
  (paymentsRes.data ?? []).forEach((p: any) => {
    const k = String(p.paid_at).slice(0, 10);
    cashInByDay.set(k, (cashInByDay.get(k) ?? 0) + Number(p.amount));
  });

  const cashOutByDay = new Map<string, number>();
  (billPaymentsRes.data ?? []).forEach((p: any) => {
    const k = String(p.paid_at).slice(0, 10);
    cashOutByDay.set(k, (cashOutByDay.get(k) ?? 0) + Number(p.amount));
  });

  const dailyCashIn: { key: string; amount: number }[] = [];
  const dailyCashOut: { key: string; amount: number }[] = [];
  for (let n = 0; n < days; n++) {
    const d = new Date(from);
    d.setDate(d.getDate() + n);
    const k = dateKey(d);
    dailyCashIn.push({ key: k, amount: cashInByDay.get(k) ?? 0 });
    dailyCashOut.push({ key: k, amount: cashOutByDay.get(k) ?? 0 });
  }

  const totalCashIn = dailyCashIn.reduce((sum, d) => sum + d.amount, 0);
  const totalCashOut = dailyCashOut.reduce((sum, d) => sum + d.amount, 0);

  return { dailyCashIn, dailyCashOut, totalCashIn, totalCashOut, netCashFlow: totalCashIn - totalCashOut };
}
