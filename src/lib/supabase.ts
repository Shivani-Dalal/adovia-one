import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Fail at module load with a sentence, rather than at the first query with
// "Invalid URL". A missing env var on Vercel is the most likely deploy failure
// in this app and it should say so.
if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Copy .env.example to .env.local for local dev, or set both in the ' +
      'Vercel project settings.',
  );
}

export const supabase = createClient(url, key, {
  auth: {
    // Magic links land as a hash fragment on whatever URL the invite pointed at.
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    flowType: 'pkce',
  },
});

/**
 * Turns a PostgREST error into something ops can read. RLS denials arrive as an
 * empty result rather than an error, so anything that reaches here is a real
 * fault; the raw `message` is usually the most useful thing we have.
 */
export function errorText(e: unknown): string {
  if (!e) return 'Something went wrong.';
  if (typeof e === 'string') return e;
  const err = e as { message?: string; details?: string; code?: string };

  // The two constraint violations ops will actually hit, named in their terms.
  if (err.code === '23505') {
    return 'That already exists — check for a duplicate invoice number or a row for this date.';
  }
  if (err.code === '23514') {
    return 'A value is out of range. Figures cannot be negative.';
  }
  return err.message || err.details || 'Something went wrong.';
}
