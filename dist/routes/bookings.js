import { z } from 'zod';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { dateRangeQuery, uuidParam } from '../lib/schemas.js';
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'];
const updateBody = z.object({
    bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startHour: z.number(),
    endHour: z.number(),
    notes: z.string().optional().nullable(),
});
const confirmBody = z.object({
    customerId: z.string().uuid().nullable(),
    customerName: z.string().trim().min(1),
    serviceId: z.string().uuid(),
    serviceName: z.string(),
    bookingType: z.enum(['time', 'slot']),
    bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startHour: z.number(),
    endHour: z.number(),
    notes: z.string().optional().nullable(),
    price: z.number().min(0),
    paymentMethod: z.enum(PAYMENT_METHODS),
});
const BOOKING_SELECT = 'id, organization_id, customer_id, customer_name, service_id, service_name, booking_type, booking_date, start_hour, end_hour, status, notes, created_at';
function bookingFromRow(row) {
    return {
        id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
        serviceId: row.service_id, serviceName: row.service_name, bookingType: row.booking_type, bookingDate: row.booking_date,
        startHour: Number(row.start_hour), endHour: Number(row.end_hour), status: row.status, notes: row.notes, createdAt: row.created_at,
    };
}
// 23P01 is the booking-overlap exclusion-constraint violation — passed
// through via sendPgError's `code` field so frontend/src/lib/bookings.ts
// can still throw BookingConflictError exactly as it does today.
export default async function bookingsRoutes(app) {
    const server = app.withTypeProvider();
    server.get('/api/bookings', { schema: { querystring: dateRangeQuery } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('bookings')
            .select(BOOKING_SELECT)
            .eq('status', 'confirmed')
            .gte('booking_date', request.query.from)
            .lte('booking_date', request.query.to)
            .order('booking_date', { ascending: true });
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(bookingFromRow));
    });
    server.get('/api/bookings/by-customer/:id', { schema: { params: uuidParam } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('bookings')
            .select(BOOKING_SELECT)
            .eq('customer_id', request.params.id)
            .order('booking_date', { ascending: false });
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(bookingFromRow));
    });
    // Reschedule / edit notes only — the GiST exclusion constraint re-validates
    // on UPDATE the same way it does on INSERT.
    server.patch('/api/bookings/:id', { schema: { params: uuidParam, body: updateBody } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('bookings')
            .update({
            booking_date: request.body.bookingDate,
            start_hour: request.body.startHour,
            end_hour: request.body.endHour,
            notes: request.body.notes || null,
        })
            .eq('id', request.params.id)
            .select(BOOKING_SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.send(bookingFromRow(data));
    });
    // One-way 'confirmed' -> 'cancelled'. Thin wrapper — cancel_booking() is
    // already a correct, atomic SECURITY DEFINER RPC (also refunds the linked
    // invoice if one exists).
    server.post('/api/bookings/:id/cancel', { schema: { params: uuidParam } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.rpc('cancel_booking', { p_booking_id: request.params.id });
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    server.delete('/api/bookings', { schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1) }) } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('bookings').delete().in('id', request.body.ids);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    // Wraps the new confirm_booking() RPC (added in
    // supabase/migrations/20260710120000_transactional_write_rpcs.sql) —
    // atomically creates the booking and its linked invoice + payment.
    server.post('/api/bookings', { schema: { body: confirmBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const b = request.body;
        const { data, error } = await auth.client.rpc('confirm_booking', {
            p_customer_id: b.customerId,
            p_customer_name: b.customerName,
            p_service_id: b.serviceId,
            p_service_name: b.serviceName,
            p_booking_type: b.bookingType,
            p_booking_date: b.bookingDate,
            p_start_hour: b.startHour,
            p_end_hour: b.endHour,
            p_notes: b.notes || null,
            p_price: b.price,
            p_payment_method: b.paymentMethod,
        });
        if (error)
            return sendPgError(reply, error);
        reply.code(201).send({ bookingId: data.bookingId, invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber });
    });
}
