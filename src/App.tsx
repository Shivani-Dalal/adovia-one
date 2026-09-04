import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
} from 'react-router-dom';
import { SessionProvider, useSession } from './auth/SessionProvider';
import { Protected, FullPageSpinner } from './auth/Protected';

import Overview from './pages/client/Overview';
import Trend from './pages/client/Trend';
import SpendReport from './pages/client/SpendReport';
import Creatives from './pages/client/Creatives';
import Invoices from './pages/client/Invoices';

import DailyEntry from './pages/admin/DailyEntry';
import ClientList from './pages/admin/ClientList';
import ClientDetail from './pages/admin/ClientDetail';

/**
 * Admins landing on `/` get sent to `/admin`. Doing this by redirect rather than
 * by rendering a different component at the same path keeps the URL honest —
 * an admin who bookmarks what they see gets an admin URL.
 */
function Root() {
  const { profile, loading, session } = useSession();
  if (loading) return <FullPageSpinner />;
  if (session && profile?.role === 'admin') return <Navigate to="/admin" replace />;
  return (
    <Protected role="client">
      <Overview />
    </Protected>
  );
}

/**
 * A data router, rather than `<BrowserRouter>` and `<Routes>`.
 *
 * The routes below are identical to what they were; the change is the router
 * that carries them. Only a data router exposes `useBlocker`, and `DailyEntry`
 * needs it: that screen holds figures that exist nowhere but the browser until
 * Save is pressed, and clicking "Clients" in the header used to throw them away
 * without a word. `beforeunload` cannot help — it fires when the BROWSER leaves
 * the page, and moving between two routes of a single-page app never does.
 *
 * Declared with `createRoutesFromElements` so the routes keep their JSX shape.
 * The object form is the more usual way to write a data router, and rewriting
 * into it would have made a diff where every route looked touched and hidden the
 * one thing that actually changed.
 *
 * Built once at module scope, which is what react-router expects: a router
 * rebuilt on each render loses the history it is holding. Nothing here reads
 * React state, so there is nothing for it to go stale against — `Root` and
 * `Protected` still read the session through context, which reaches them because
 * `RouterProvider` renders BELOW `SessionProvider` in the tree below.
 *
 * No loaders, and deliberately none. Every screen fetches in its own effect
 * against RLS-protected tables, and moving that into route loaders would be a
 * rewrite of the whole data layer for no gain here.
 */
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<Root />} />
      <Route
        path="/trend"
        element={
          <Protected role="client">
            <Trend />
          </Protected>
        }
      />
      <Route
        path="/spend"
        element={
          <Protected role="client">
            <SpendReport />
          </Protected>
        }
      />
      <Route
        path="/creatives"
        element={
          <Protected role="client">
            <Creatives />
          </Protected>
        }
      />
      <Route
        path="/invoices"
        element={
          <Protected role="client">
            <Invoices />
          </Protected>
        }
      />

      <Route
        path="/admin"
        element={
          <Protected role="admin">
            <DailyEntry />
          </Protected>
        }
      />
      <Route
        path="/admin/clients"
        element={
          <Protected role="admin">
            <ClientList />
          </Protected>
        }
      />
      <Route
        path="/admin/clients/:id"
        element={
          <Protected role="admin">
            <ClientDetail />
          </Protected>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </>,
  ),
);

export default function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
