import { useState, type FormEvent } from 'react';
import { supabase, errorText } from '../lib/supabase';
import { Brand } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';

/**
 * Magic link only. There is no signup — accounts arrive by invite from the
 * admin — so this screen has one field and one outcome.
 *
 * `shouldCreateUser: false` is the load-bearing option: without it, signInWithOtp
 * silently creates an account for any address typed here, and that account gets
 * a role='client' profile with a null client_id which then fails a constraint.
 * With it, an unknown address gets the same "check your inbox" message and no
 * email, which is also the right answer for enumeration.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    });

    setBusy(false);

    // Rate limiting is worth surfacing; "user not found" is not, and Supabase
    // returns it as a 400 we deliberately swallow into the success state.
    if (err && !/signups not allowed|user not found/i.test(err.message)) {
      setError(errorText(err));
      return;
    }
    setSent(true);
  }

  return (
    <div className="login">
      <div className="login-card">
        <Brand />

        {sent ? (
          <>
            <h1>Check your inbox</h1>
            <p className="muted">
              If <strong>{email.trim().toLowerCase()}</strong> has access, a sign-in link
              is on its way. It expires in an hour and works once.
            </p>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setSent(false);
                setError(null);
              }}
            >
              Use a different address
            </button>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <p className="muted">
              Enter the email your Adovia contact set up. We&rsquo;ll send a link —
              there&rsquo;s no password to remember.
            </p>
            <form onSubmit={submit}>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
              {error && <p className="error">{error}</p>}
              <button className="btn" disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send sign-in link'}
              </button>
            </form>
          </>
        )}
      </div>
      {/*
        The toggle is here too, not only behind the sign-in. Someone who wants
        dark shouldn't have to cross a white screen to reach the switch, and
        the preference is stored per browser, so setting it here carries in.
      */}
      <div className="login-foot">
        <p>Access is by invitation. Ask your Adovia contact if you need one.</p>
        <ThemeToggle />
      </div>
    </div>
  );
}
