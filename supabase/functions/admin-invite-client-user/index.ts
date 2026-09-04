// ---------------------------------------------------------------------------
// admin-invite-client-user
//
// The only piece of this product that needs the service-role key, and therefore
// the only piece that cannot run in the browser.
//
// It does three things in a deliberate order:
//   1. Verifies the CALLER is an admin. A service-role function that trusts its
//      caller is the one real security hole available in this design — anyone
//      with a client login could otherwise mint themselves an admin account.
//   2. Validates client_id names a real client BEFORE inviting. Without this the
//      profiles_role_client_match constraint aborts the auth.users insert and
//      surfaces as an opaque 500.
//   3. Invites, passing role and client_id in user metadata for the
//      handle_new_user() trigger to copy into profiles.
//
// Deploy:  supabase functions deploy admin-invite-client-user
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are
//          injected by the platform. SITE_URL must be set by hand.
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://open.adovia.in';

// Not a wildcard. The browser sends an Authorization header on this call, so a
// permissive CORS policy would let any origin replay a logged-in admin's token.
const ALLOWED_ORIGINS = new Set([SITE_URL, 'http://localhost:5273']);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : SITE_URL;
  return {
    'Access-Control-Allow-Origin': allow,
    // supabase-js sends apikey and x-client-info on every functions.invoke.
    // Omitting either fails the preflight, and the browser then drops the POST
    // without ever calling the function.
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  // --- 1. Who is calling? ---------------------------------------------------

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing bearer token' }, 401, origin);
  }

  // A client bound to the caller's JWT, using the anon key. Every query below
  // runs under the caller's own RLS, which is the point: if the profiles read
  // returns nothing, they are not an admin.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: 'Invalid session' }, 401, origin);
  }

  const { data: profile, error: profileErr } = await caller
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileErr) {
    return json({ error: 'Could not verify caller' }, 500, origin);
  }
  if (profile?.role !== 'admin') {
    // Same message and status whether the profile is missing or is a client.
    // Telling a client account which of the two it is tells them nothing useful
    // and tells an attacker something.
    return json({ error: 'Admins only' }, 403, origin);
  }

  // --- 2. Is the request well formed? ---------------------------------------

  let body: { email?: unknown; client_id?: unknown; full_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
  const fullName =
    typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 160) : '';

  if (!EMAIL_RE.test(email)) {
    return json({ error: 'A valid email is required' }, 400, origin);
  }
  if (!UUID_RE.test(clientId)) {
    return json({ error: 'client_id must be a client UUID' }, 400, origin);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The check that stops the opaque 500. profiles_role_client_match would
  // reject a null client_id anyway, but only after the auth.users insert has
  // already begun, and the failure arrives here unreadable.
  const { data: client, error: clientErr } = await admin
    .from('clients')
    .select('id, name, status')
    .eq('id', clientId)
    .maybeSingle();

  if (clientErr) {
    return json({ error: 'Could not look up client' }, 500, origin);
  }
  if (!client) {
    return json({ error: 'No client with that id' }, 404, origin);
  }
  if (client.status === 'archived') {
    return json({ error: `${client.name} is archived` }, 409, origin);
  }

  // --- 3. Invite ------------------------------------------------------------

  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    {
      data: { role: 'client', client_id: clientId, full_name: fullName || null },
      redirectTo: SITE_URL,
    },
  );

  if (inviteErr) {
    // Already-registered is the common case and is not really an error from
    // ops' point of view, so it gets its own status and a sentence they can act
    // on rather than a raw GoTrue message.
    const already = /already been registered|already exists/i.test(inviteErr.message);
    return json(
      {
        error: already
          ? `${email} already has an account. Check the user list before re-inviting.`
          : inviteErr.message,
      },
      already ? 409 : 400,
      origin,
    );
  }

  return json(
    { ok: true, user_id: invited.user?.id, email, client: client.name },
    200,
    origin,
  );
});
