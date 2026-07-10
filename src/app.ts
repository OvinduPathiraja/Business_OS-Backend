import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { bearerTokenFrom } from './lib/supabase.js';
import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import organizationsRoutes from './routes/organizations.js';
import customersRoutes from './routes/customers.js';
import servicesRoutes from './routes/services.js';
import inventoryRoutes from './routes/inventory.js';
import ordersRoutes from './routes/orders.js';
import bookingsRoutes from './routes/bookings.js';
import financeRoutes from './routes/finance.js';
import rolesRoutes from './routes/roles.js';
import employeesRoutes from './routes/employees.js';
import notificationsRoutes from './routes/notifications.js';
import reportsRoutes from './routes/reports.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  app.register(cors, {
    origin: allowedOrigin ? allowedOrigin.split(',').map((o) => o.trim()) : true,
  });

  // In-memory store — fine for one instance. A shared store (Redis) would be
  // needed once Railway runs more than one; not built until that's real.
  app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => bearerTokenFrom(request.headers.authorization) ?? request.ip,
  });

  // Safety net for anything *thrown* (Zod validation failures via the
  // validatorCompiler above, or an unexpected bug) — Postgres/PostgREST
  // errors returned as `{ error }` from a supabase-js call are handled at
  // the call site via sendPgError(), not here.
  app.setErrorHandler((err: FastifyError | ZodError, request, reply) => {
    if (err instanceof ZodError || (err as FastifyError).validation) {
      reply.code(400).send({ error: err.message, code: 'VALIDATION_ERROR' });
      return;
    }
    const fastifyErr = err as FastifyError;
    if (fastifyErr.statusCode === 429) {
      reply.code(429).send({ error: 'Too many requests.', code: 'RATE_LIMITED' });
      return;
    }
    request.log.error(err);
    reply.code(fastifyErr.statusCode ?? 500).send({ error: 'Internal server error.' });
  });

  app.register(healthRoutes);
  app.register(meRoutes);
  app.register(organizationsRoutes);
  app.register(customersRoutes);
  app.register(servicesRoutes);
  app.register(inventoryRoutes);
  app.register(ordersRoutes);
  app.register(bookingsRoutes);
  app.register(financeRoutes);
  app.register(rolesRoutes);
  app.register(employeesRoutes);
  app.register(notificationsRoutes);
  app.register(reportsRoutes);

  return app;
}
