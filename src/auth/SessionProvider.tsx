import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Client, Profile } from '../lib/types';

interface SessionState {
  session: Session | null;
  profile: Profile | null;
  /** The client a `role='client'` user belongs to. Null for admins. */
  client: Client | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState>({
  session: null,
  profile: null,
  client: null,
  loading: true,
  signOut: async () => {},
});

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      setSession(next);
      // Clear derived state immediately on sign-out, before any fetch settles.
      // Leaving a stale profile in place for even one render is how the wrong
      // shell flashes up in a multi-tenant app.
      if (!next) {
        setProfile(null);
        setClient(null);
      }
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!session?.user) {
        setProfile(null);
        setClient(null);
        setLoading(false);
        return;
      }

      setLoading(true);

      // RLS restricts this to the caller's own row, so no filter is strictly
      // needed — the eq() is here so the query says what it means.
      const { data: p } = await supabase
        .from('profiles')
        .select('id, role, client_id, full_name')
        .eq('id', session.user.id)
        .maybeSingle();

      if (!alive) return;
      setProfile((p as Profile) ?? null);

      if (p?.client_id) {
        const { data: c } = await supabase
          .from('clients')
          .select('*')
          .eq('id', p.client_id)
          .maybeSingle();
        if (!alive) return;
        setClient((c as Client) ?? null);
      } else {
        setClient(null);
      }

      setLoading(false);
    }

    void load();
    return () => {
      alive = false;
    };
  }, [session?.user?.id]);

  const value = useMemo<SessionState>(
    () => ({
      session,
      profile,
      client,
      loading,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, profile, client, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
