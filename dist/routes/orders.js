import { z } from 'zod';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'];
const listQuery = paginationQuery.extend({
    status: z.enum(['completed', 'refunded']).optional(),
    customerId: z.string().uuid().optional(),
});
const updateBody = z.object({
    customerId: z.string().uuid().nullable(),
    customerName: z.string().trim().min(1),
    notes: z.string().optional().nullable(),
});
const completeOrderBody = z.object({
    customerId: z.string().uuid().nullable(),
    customerName: z.string().trim().min(1),
    subtotal: z.number(),
    tax: z.number(),
    total: z.number(),
    items: z.array(z.object({
        serviceId: z.string().uuid(),
        name: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
    })).min(1),
    paymentMethod: z.enum(PAYMENT_METHODS),
});
const ORDER_SELECT = 'id, organization_id, customer_id, customer_name, status, subtotal, tax, total, notes, created_at, order_items(count)';
const ORDER_DETAIL_SELECT = 'id, organization_id, customer_id, customer_name, status, subtotal, tax, total, notes, created_at, order_items(id, service_id, item_name, quantity, unit_price, line_total)';
function orderFromRow(row) {
    const itemCountRow = Array.isArray(row.order_items) ? row.order_items[0] : row.order_items;
    return {
        id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
        status: row.status, subtotal: Number(row.subtotal), tax: Number(row.tax), total: Number(row.total),
        notes: row.notes, itemCount: Number(itemCountRow?.count ?? 0), createdAt: row.created_at,
    };
}
function orderWithItemsFromRow(row) {
    const items = Array.isArray(row.order_items) ? row.order_items : [];
    return {
        id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
        status: row.status, subtotal: Number(row.subtotal), tax: Number(row.tax), total: Number(row.total),
        notes: row.notes, itemCount: items.length, createdAt: row.created_at,
        items: items.map((it) => ({
            id: it.id, serviceId: it.service_id, itemName: it.item_name,
            quantity: Number(it.quantity), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total),
        })),
    };
}
export default async function ordersRoutes(app) {
    const server = app.withTypeProvider();
    // Flat, org-wide order_items — used by the Reports aggregation to build a
    // top-services breakdown.
    server.get('/api/order-items', async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client.from('order_items').select('service_id, item_name, quantity, line_total, created_at');
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map((r) => ({
            serviceId: r.service_id, itemName: r.item_name, quantity: Number(r.quantity),
            lineTotal: Number(r.line_total), createdAt: r.created_at,
        })));
    });
    server.get('/api/orders', { schema: { querystring: listQuery } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        let query = auth.client.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false });
        const { search, status, customerId, limit, offset } = request.query;
        if (search)
            query = query.ilike('customer_name', `%${search}%`);
        if (status)
            query = query.eq('status', status);
        if (customerId)
            query = query.eq('customer_id', customerId);
        query = query.range(offset, offset + limit - 1);
        const { data, error } = await query;
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(orderFromRow));
    });
    server.get('/api/orders/:id', { schema: { params: uuidParam } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client.from('orders').select(ORDER_DETAIL_SELECT).eq('id', request.params.id).single();
        if (error)
            return sendPgError(reply, error);
        reply.send(orderWithItemsFromRow(data));
    });
    // Narrow, non-financial edit — customer link and notes only. Reversing a
    // sale is the /refund action below, not this.
    server.patch('/api/orders/:id', { schema: { params: uuidParam, body: updateBody } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('orders')
            .update({ customer_id: request.body.customerId, customer_name: request.body.customerName, notes: request.body.notes || null })
            .eq('id', request.params.id)
            .select(ORDER_SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.send(orderFromRow(data));
    });
    server.delete('/api/orders', { schema: { body: bulkIdsBody } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('orders').delete().in('id', request.body.ids);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    // One-way 'completed' -> 'refunded'. Thin wrapper — refund_order() is
    // already a correct, atomic SECURITY DEFINER RPC.
    server.post('/api/orders/:id/refund', { schema: { params: uuidParam } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.rpc('refund_order', { p_order_id: request.params.id });
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    // Wraps the new complete_order() RPC (added in
    // supabase/migrations/20260710120000_transactional_write_rpcs.sql) —
    // atomically creates the order, its line items, the linked invoice, and
    // the payment in one transaction, instead of 4 sequential client inserts.
    server.post('/api/orders', { schema: { body: completeOrderBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const b = request.body;
        const notes = b.items.map((it) => `${it.name} ×${it.quantity}`).join(', ');
        const { data, error } = await auth.client.rpc('complete_order', {
            p_customer_id: b.customerId,
            p_customer_name: b.customerName,
            p_subtotal: b.subtotal,
            p_tax: b.tax,
            p_total: b.total,
            p_items: b.items.map((it) => ({ serviceId: it.serviceId, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
            p_notes: notes,
            p_payment_method: b.paymentMethod,
        });
        if (error)
            return sendPgError(reply, error);
        reply.code(201).send({ orderId: data.orderId, invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber });
    });
}
