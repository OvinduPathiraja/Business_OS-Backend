import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';

const PERIODS = [7, 30, 90] as const;
const reportsQuery = z.object({
  period: z.coerce.number().refine((n): n is (typeof PERIODS)[number] => (PERIODS as readonly number[]).includes(n)).optional().default(30),
});

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Replaces Reports.tsx's old "fetch 5 unbounded tables, aggregate in the
// browser" pattern — every screen except this one is at least bounded to
// one tenant's current working set; this was the one that got slower every
// day as data accumulated. Filtering happens in the query (bounded by the
// requested period); grouping/summing happens here in TypeScript, porting
// Reports.tsx's old useMemo chains almost verbatim — hand-rolling SQL
// GROUP BY is premature at SMB-tenant row counts. The actual scale fix is
// bounding *query result size* to the requested window, not where the
// arithmetic runs.
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/reports', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const period = c.req.valid('query').period;
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

  return c.json({
    period,
    kpis: {
      revenue: totalRevenue,
      ordersCount: (ordersRes.data ?? []).length,
      bookingsCount: (bookingsRes.data ?? []).length,
      outstandingAR,
    },
    dailyRevenue,
    topServices,
    lowStockItems,
  });
});

export default app;
