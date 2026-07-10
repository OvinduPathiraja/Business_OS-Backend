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
export const bulkIdsBody = z.object({ ids: z.array(z.string().uuid()).min(1) });
