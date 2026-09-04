import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from './SessionProvider';
import { Brand } from '../components/Logo';
import Login from './Login';

/**
 * Gate for every routed screen.
 *
 * Note what this does NOT do: it does not decide who may read which rows. RLS
 * does that, in the database, and would keep doing it if this component were
 * deleted. What lives here is which shell a user sees — routing, not
 * authorisation. Treating it as authorisation is how a client ends up one URL
 * away from an admin screen that then returns nothing and looks broken.
 */
export function Protected({
  role,
  children,
}: {
  role?: 'admin' | 'client';
  children: ReactNode;
}) {
  const { session, profile, loading } = useSession();

  if (loading) return <FullPageSpinner />;
  if (!session) return <Login />;

  // Signed in, but no profile row. Means the invite trigger did not run — an
  // ops problem, not something the user can fix by retrying.
  if (!profile) {
    return (
      <div className="login">
        <div className="login-card">
          <Brand />
          <h1>Account not set up</h1>
          <p className="muted">
            You&rsquo;re signed in, but this account isn&rsquo;t linked to a client yet.
            Email <a href="mailto:hello@adovia.in">hello@adovia.in</a> and we&rsquo;ll fix
            it.
          </p>
        </div>
      </div>
    );
  }

  if (role && profile.role !== role) {
    return <Navigate to={profile.role === 'admin' ? '/admin' : '/'} replace />;
  }

  return <>{children}</>;
}

export function FullPageSpinner() {
  return (
    <div className="full-spinner" role="status" aria-live="polite">
      <span className="spinner" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
