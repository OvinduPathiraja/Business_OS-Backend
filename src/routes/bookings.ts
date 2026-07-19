import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { dateRangeQuery, uuidParam } from '../lib/schemas.js';

const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;

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
});

const bulkIdsBody = z.object({ ids: z.array(z.string().uuid()).min(1) });

// Same shape as orders.ts's completeOrderBody — converting a booking creates
// a real order exactly like a walk-in one does, just sourced from a booking.
const lineItemSchema = z.object({
  serviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  name: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
}).refine((it) => Boolean(it.serviceId) !== Boolean(it.variantId), {
  message: 'Each line item must have exactly one of serviceId or variantId.',
});

const convertBody = z.object({
  customerId: z.string().uuid().nullable(),
  customerName: z.string().trim().min(1),
  subtotal: z.number(),
  discount: z.number().min(0).optional(),
  tax: z.number(),
  total: z.number(),
  items: z.array(lineItemSchema).min(1),
  paymentMethod: z.enum(PAYMENT_METHODS),
  branchId: z.string().uuid().optional().nullable(),
});

const BOOKING_SELECT = 'id, organization_id, customer_id, customer_name, service_id, service_name, booking_type, booking_date, start_hour, end_hour, status, notes, created_at';

function bookingFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id, customerName: row.customer_name,
    serviceId: row.service_id, serviceName: row.service_name, bookingType: row.booking_type, bookingDate: row.booking_date,
    startHour: Number(row.start_hour), endHour: Number(row.end_hour), status: row.status, notes: row.notes, createdAt: row.created_at,
  };
}

// 23P01 is the booking-overlap exclusion-constraint violation — passed
// through via sendPgError's `code` field so frontend/src/lib/bookings.ts
// can still throw BookingConflictError exactly as it does today.
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/bookings', validate('query', dateRangeQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('status', 'confirmed')
    .gte('booking_date', from)
    .lte('booking_date', to)
    .order('booking_date', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(bookingFromRow));
});

app.get('/api/bookings/by-customer/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('customer_id', c.req.valid('param').id)
    .order('booking_date', { ascending: false });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(bookingFromRow));
});

// Reschedule / edit notes only — the GiST exclusion constraint re-validates
// on UPDATE the same way it does on INSERT.
app.patch('/api/bookings/:id', validate('param', uuidParam), validate('json', updateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('bookings')
    .update({
      booking_date: body.bookingDate,
      start_hour: body.startHour,
      end_hour: body.endHour,
      notes: body.notes || null,
    })
    .eq('id', c.req.valid('param').id)
    .select(BOOKING_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(bookingFromRow(data));
});

// One-way 'confirmed' -> 'cancelled'. Thin wrapper — cancel_booking() is
// already a correct, atomic SECURITY DEFINER RPC (also refunds the linked
// invoice if one exists).
app.post('/api/bookings/:id/cancel', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('cancel_booking', { p_booking_id: c.req.valid('param').id });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.delete('/api/bookings', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('bookings').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps the confirm_booking() RPC — a booking is just a reservation, no
// invoice/payment is created here. Money only changes hands once the
// booking is converted to an order (see /convert below) or a walk-in order
// is completed directly.
app.post('/api/bookings', validate('json', confirmBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
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
  });
  if (error) return sendPgError(c, error);
  return c.json({ bookingId: data.bookingId }, 201);
});

// The customer arrived — wraps the convert_booking_to_order() RPC, which
// atomically flips the booking 'confirmed' -> 'fulfilled' and creates a real
// order + line items + paid invoice + payment, exactly like POST /api/orders
// does for a walk-in sale.
app.post('/api/bookings/:id/convert', validate('param', uuidParam), validate('json', convertBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const notes = b.items.map((it) => `${it.name} ×${it.quantity}`).join(', ');

  const { data, error } = await auth.client.rpc('convert_booking_to_order', {
    p_booking_id: c.req.valid('param').id,
    p_customer_id: b.customerId,
    p_customer_name: b.customerName,
    p_subtotal: b.subtotal,
    p_tax: b.tax,
    p_total: b.total,
    p_items: b.items.map((it) => ({ serviceId: it.serviceId ?? null, variantId: it.variantId ?? null, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
    p_notes: notes,
    p_payment_method: b.paymentMethod,
    p_branch_id: b.branchId || null,
    p_discount: b.discount ?? 0,
  });
  if (error) return sendPgError(c, error);
  return c.json({ orderId: data.orderId, invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber, branchId: data.branchId }, 201);
});

export default app;
