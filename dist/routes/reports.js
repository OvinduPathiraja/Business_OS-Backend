import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
const PERIODS = [7, 30, 90];
const reportsQuery = z.object({
    period: z.coerce.number().refine((n) => PERIODS.includes(n)).optional().default(30),
});
function dateKey(d) {
    return d.toISOString().slice(0, 10);
}
function startOfToday() {
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
export default async function reportsRoutes(app) {
    const server = app.withTypeProvider();
    server.get('/api/reports', { schema: { querystring: reportsQuery } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const period = request.query.period;
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
            if (res.error)
                return sendPgError(reply, res.error);
        }
        const totalRevenue = (paidInvoicesRes.data ?? []).reduce((sum, i) => sum + Number(i.total), 0);
        const outstandingAR = (outstandingInvoicesRes.data ?? []).reduce((sum, i) => sum + (Number(i.total) - Number(i.amount_paid)), 0);
        const byDay = new Map();
        (paidInvoicesRes.data ?? []).forEach((i) => {
            const k = String(i.created_at).slice(0, 10);
            byDay.set(k, (byDay.get(k) ?? 0) + Number(i.total));
        });
        const dailyRevenue = [];
        for (let n = 0; n < period; n++) {
            const d = new Date(cutoff);
            d.setDate(d.getDate() + n);
            const k = dateKey(d);
            dailyRevenue.push({ key: k, amount: byDay.get(k) ?? 0 });
        }
        const byService = new Map();
        (orderItemsRes.data ?? []).forEach((it) => {
            const id = it.service_id ?? it.item_name;
            const existing = byService.get(id) ?? { id, name: it.item_name, count: 0, revenue: 0 };
            existing.count += Number(it.quantity);
            existing.revenue += Number(it.line_total);
            byService.set(id, existing);
        });
        const topServices = Array.from(byService.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
        const lowStockItems = (itemsRes.data ?? [])
            .filter((it) => Number(it.quantity_on_hand) <= Number(it.reorder_point))
            .map((it) => ({
            id: it.id, name: it.name, unit: it.unit,
            quantityOnHand: Number(it.quantity_on_hand), reorderPoint: Number(it.reorder_point),
        }));
        reply.send({
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
}
