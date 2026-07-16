import type { Bindings } from './supabase.js';

// The one real transactional-email path in this project. Everything else —
// new-account signup, new-account employee invites — goes through Supabase
// Auth's own built-in emails; this exists specifically because
// admin.inviteUserByEmail() fails outright for an email that already has an
// account, so inviting an existing user into a second organization needs a
// plain notification instead (see backend/src/routes/employees.ts). No
// magic link — the in-app pending-invite (accept_organization_invite RPC)
// handles acceptance once they're signed in, this just points them at the app.
export async function sendInviteEmail(
  env: Bindings,
  params: { to: string; orgName: string; appUrl: string }
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM_ADDRESS,
      to: params.to,
      subject: `You've been invited to join ${params.orgName}`,
      text: `You've been invited to join ${params.orgName} on Business OS.\n\nLog in to accept: ${params.appUrl}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send invite email (${res.status})`);
  }
}
