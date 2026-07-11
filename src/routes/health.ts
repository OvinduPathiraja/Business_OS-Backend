import { Hono } from 'hono';
import type { Bindings } from '../lib/supabase.js';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true }));

export default app;
