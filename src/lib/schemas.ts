import { z } from 'zod';

export const uuidParam = z.object({ id: z.string().uuid() });

// Shared by every list route. `search` is applied per-route (different
// columns per resource); limit/offset are consistent everywhere. Nothing in
// the UI passes these yet (see ROADMAP) — the server-side cap (max 200,
// default 50) is the actual "design for scale" guard, invisible today.
export const paginationQuery = z.object({
  search: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const dateRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Same shape as dateRangeQuery, but both bounds optional — for list routes
// where a date-range filter is one of several optional query params rather
// than the sole way of scoping the query (see bookings.ts for that case).
export const optionalDateRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const bulkIdsBody = z.object({ ids: z.array(z.string().uuid()).min(1) });
