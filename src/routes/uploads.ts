import { Hono } from 'hono';
import type { Bindings } from '../lib/supabase.js';
import { createServiceClient, createUserClient } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';

// Where an uploaded image is used — decides its folder inside the shared
// org-assets bucket and which permission the uploader needs. 'inventory'
// covers a product photo attached from either the create or edit form, so
// either permission is accepted. 'branding' is unused today (the org logo
// and invoice/quotation/PO logos are still paste-a-URL fields) but costs
// nothing to support now, ahead of pointing those at this same endpoint.
const UPLOAD_PURPOSES: Record<string, { permissions: string[] }> = {
  inventory: { permissions: ['inventory.add', 'inventory.update'] },
  branding: { permissions: ['settings.update'] },
};

const MAX_BYTES = 5 * 1024 * 1024;
const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

async function hasAnyPermission(client: ReturnType<typeof createUserClient>, keys: string[]): Promise<boolean> {
  for (const key of keys) {
    const { data, error } = await client.rpc('has_permission', { p_key: key });
    if (!error && data) return true;
  }
  return false;
}

const app = new Hono<{ Bindings: Bindings }>();

// Proxies image uploads through the backend rather than letting the client
// write to Supabase Storage directly — see the top comment on
// 20260729030000_org_assets_bucket.sql for why storage.objects RLS can't
// reuse this schema's usual org-scoping. The permission is checked here
// (via the same has_permission() RPC every table's RLS policies call), and
// only then is the file written with the service-role client, which
// bypasses storage RLS entirely — the check already happened.
app.post('/api/uploads/:purpose', async (c) => {
  const purpose = c.req.param('purpose');
  const config = UPLOAD_PURPOSES[purpose];
  if (!config) return c.json({ error: 'Unknown upload type.' }, 400);

  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  if (!(await hasAnyPermission(auth.client, config.permissions))) {
    return c.json({ error: 'You do not have permission to upload images.' }, 403);
  }

  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'Invalid upload — expected multipart/form-data.' }, 400);
  }
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'No file uploaded.' }, 400);
  }

  const ext = EXT_FOR_TYPE[file.type];
  if (!ext) {
    return c.json({ error: 'Unsupported image type — use JPEG, PNG, WEBP, or GIF.' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: `Image is too large — max ${(MAX_BYTES / (1024 * 1024)).toFixed(0)}MB.` }, 400);
  }

  const path = `${auth.organizationId}/${purpose}/${crypto.randomUUID()}.${ext}`;
  const svc = createServiceClient(c.env);
  const { error: uploadError } = await svc.storage.from('org-assets').upload(path, await file.arrayBuffer(), {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) {
    return c.json({ error: uploadError.message || 'Failed to upload image.' }, 500);
  }

  const { data } = svc.storage.from('org-assets').getPublicUrl(path);
  return c.json({ url: data.publicUrl }, 201);
});

export default app;
