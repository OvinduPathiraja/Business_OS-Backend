import { z } from 'zod';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
const createOrgBody = z.object({ name: z.string().trim().min(1) });
const updateCurrencyBody = z.object({ currency: z.string().length(3) });
const settingsBody = z.object({
    screenType: z.enum(['guided', 'single', 'compact']).optional(),
    controlSize: z.enum(['comfortable', 'large', 'xlarge']).optional(),
});
export default async function organizationsRoutes(app) {
    const server = app.withTypeProvider();
    // Onboarding — the caller has no org yet, so requireUser() only (there is
    // nothing for requireOrg() to find). Thin wrapper: create_organization()
    // is already a correct, atomic SECURITY DEFINER RPC.
    server.post('/api/organizations', { schema: { body: createOrgBody } }, async (request, reply) => {
        const auth = await requireUser(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client.rpc('create_organization', { org_name: request.body.name });
        if (error)
            return sendPgError(reply, error);
        reply.code(201).send({ organizationId: data });
    });
    server.patch('/api/organization', { schema: { body: updateCurrencyBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client
            .from('organizations')
            .update({ currency: request.body.currency })
            .eq('id', auth.organizationId);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    server.get('/api/organization/settings', async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('organization_settings')
            .select('screen_type, control_size')
            .eq('organization_id', auth.organizationId)
            .maybeSingle();
        if (error)
            return sendPgError(reply, error);
        if (!data) {
            reply.send({ screenType: 'guided', controlSize: 'comfortable' });
            return;
        }
        reply.send({ screenType: data.screen_type, controlSize: data.control_size });
    });
    server.patch('/api/organization/settings', { schema: { body: settingsBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('organization_settings').upsert({
            organization_id: auth.organizationId,
            ...(request.body.screenType ? { screen_type: request.body.screenType } : {}),
            ...(request.body.controlSize ? { control_size: request.body.controlSize } : {}),
            updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id' });
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
}
