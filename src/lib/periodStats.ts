import type { Context } from 'hono';
import type { Bindings } from './supabase.js';
import type { AuthResult } from './auth.js';
import { sendPgError } from './errors.js';

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

export interface PeriodStats {
  kpis: {
    revenue: number;
    ordersCount: number;
    bookingsCount: number;
    outstandingAR: number;
  };
  dailyRevenue: { key: string; amount: number }[];
  topServices: { id: string; name: string; count: number; revenue: number }[];
  lowStockItems: { id: string; name: string; unit: string; quantityOnHand: number; reorderPoint: number }[];
}

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Extracted out of reports.ts (which was the sole caller) so dashboard.ts can
// reuse the same period-scoped aggregation without duplicating these ~6
// queries. Body is unchanged from reports.ts's original inline version —
// same query shape, same in-TypeScript grouping/summing rationale (bounding
// *query result size* to the requested window is the actual scale fix here,
// not hand-rolled SQL GROUP BY, at SMB-tenant row counts).
export async function computePeriodStats(
  c: Context<{ Bindings: Bindings }>,
  auth: AuthResult,
  period: Period
): Promise<PeriodStats | Response> {
  const today = startOfToday();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (period - 1));
  const cutoffKey = dateKey(cutoff);
  const todayKey = dateKey(today);
  const cutoffIso = cutoff.toISOString();

  const [ordersRes, paidInvoicesRes, outstandingInvoicesRes, bookingsRes, orderItemsRes, itemsRes] = await Promise.all([
    auth.client.from('orders').select('id, created_at').gte('created_at', cutoffIso),
    auth.client.from('invoices').select('id, total, created_at').eq('status', 'paid').gte('created_at', cutoffIso),
    // Same predicate as frontend/src/lib/finance.ts's isOutstandingInvoice()
    // — unbounded by date on purpose, AR aging cares about old unpaid
    // invoices specifically.
    auth.client.from('invoices').select('total, amount_paid').neq('status', 'paid').neq('status', 'void').neq('status', 'refunded'),
    auth.client.from('bookings').select('id, booking_date').eq('status', 'confirmed').gte('booking_date', cutoffKey).lte('booking_date', todayKey),
    auth.client.from('order_items').select('service_id, item_name, quantity, line_total, created_at').gte('created_at', cutoffIso),
    auth.client.from('inventory_items').select('id, name, unit, quantity_on_hand, reorder_point'),
  ]);

  for (const res of [ordersRes, paidInvoicesRes, outstandingInvoicesRes, bookingsRes, orderItemsRes, itemsRes]) {
    if (res.error) return sendPgError(c, res.error);
  }

  const totalRevenue = (paidInvoicesRes.data ?? []).reduce((sum, i: any) => sum + Number(i.total), 0);
  const outstandingAR = (outstandingInvoicesRes.data ?? []).reduce((sum, i: any) => sum + (Number(i.total) - Number(i.amount_paid)), 0);

  const byDay = new Map<string, number>();
  (paidInvoicesRes.data ?? []).forEach((i: any) => {
    const k = String(i.created_at).slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + Number(i.total));
  });
  const dailyRevenue: { key: string; amount: number }[] = [];
  for (let n = 0; n < period; n++) {
    const d = new Date(cutoff);
    d.setDate(d.getDate() + n);
    const k = dateKey(d);
    dailyRevenue.push({ key: k, amount: byDay.get(k) ?? 0 });
  }

  const byService = new Map<string, { id: string; name: string; count: number; revenue: number }>();
  (orderItemsRes.data ?? []).forEach((it: any) => {
    const id = it.service_id ?? it.item_name;
    const existing = byService.get(id) ?? { id, name: it.item_name, count: 0, revenue: 0 };
    existing.count += Number(it.quantity);
    existing.revenue += Number(it.line_total);
    byService.set(id, existing);
  });
  const topServices = Array.from(byService.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  const lowStockItems = (itemsRes.data ?? [])
    .filter((it: any) => Number(it.quantity_on_hand) <= Number(it.reorder_point))
    .map((it: any) => ({
      id: it.id, name: it.name, unit: it.unit,
      quantityOnHand: Number(it.quantity_on_hand), reorderPoint: Number(it.reorder_point),
    }));

  return {
    kpis: {
      revenue: totalRevenue,
      ordersCount: (ordersRes.data ?? []).length,
      bookingsCount: (bookingsRes.data ?? []).length,
      outstandingAR,
    },
    dailyRevenue,
    topServices,
    lowStockItems,
  };
}
