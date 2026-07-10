import type { FastifyReply } from 'fastify';

// Maps a Postgres/PostgREST error (the `{ error }` half of every supabase-js
// result) to an HTTP status + response body, so route handlers just do
// `if (error) return sendPgError(reply, error);` instead of hand-rolling a
// status code at every call site. `code` is passed through verbatim so the
// frontend can still branch on it (e.g. 23P01 -> BookingConflictError).
export function sendPgError(reply: FastifyReply, error: { message: string; code?: string }) {
  reply.code(statusForCode(error.code)).send({ error: error.message, code: error.code });
}

function statusForCode(code: string | undefined): number {
  switch (code) {
    case '23P01': // exclusion violation (e.g. overlapping booking)
    case '23505': // unique violation
    case '23503': // foreign key violation
      return 409;
    case '42501': // RLS WITH CHECK rejection
      return 403;
    case 'PGRST116': // .single() found no row
      return 404;
    case 'P0001': // plpgsql `raise exception` — every existing RPC guard uses this
      return 400;
    default:
      return 500;
  }
}
