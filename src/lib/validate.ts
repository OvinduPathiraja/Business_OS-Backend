import { zValidator } from '@hono/zod-validator';
import type { z } from 'zod';

// Wraps @hono/zod-validator with the same {error, code: 'VALIDATION_ERROR'}
// envelope every other failure mode in this API uses (see errors.ts) —
// zValidator's default failure response doesn't match that shape on its own.
export function validate<T extends z.ZodTypeAny>(target: 'json' | 'query' | 'param', schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.message, code: 'VALIDATION_ERROR' }, 400);
    }
  });
}
