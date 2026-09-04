import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../auth/SessionProvider';
import { Brand } from './Logo';
import { ThemeToggle } from './ThemeToggle';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const CLIENT_NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/trend', label: 'Trend' },
  { to: '/spend', label: 'Spend report' },
  { to: '/creatives', label: 'Creatives' },
  { to: '/invoices', label: 'Invoices' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Daily entry', end: true },
  { to: '/admin/clients', label: 'Clients' },
];

export function Shell({
  children,
  unsaved,
}: {
  children: ReactNode;
  /**
   * Work that only exists in this browser, for the one control up here that can
   * destroy it.
   *
   * Signing out is the last unguarded exit from the daily entry grid, and the
   * only one that needs telling about. It is not a navigation — `signOut` clears
   * the session and `Protected` swaps the login screen in where it stands — so
   * neither `beforeunload` nor the router's blocker ever sees it.
   *
   * `ask` rather than a count and a dialog of its own. The shell has no idea what
   * a row is or what a client is called, and a second "are you sure" written from
   * up here would drift out of step with the one the grid already shows. So this
   * hands the question back to whoever owns the work: if there is any, the button
   * calls `ask` instead of signing out, and the caller decides what to display
   * and calls `signOut` itself once it has an answer.
   */
  unsaved?: { count: number; ask: () => void };
}) {
  const { profile, client, session, signOut } = useSession();
  const isAdmin = profile?.role === 'admin';
  const nav = isAdmin ? ADMIN_NAV : CLIENT_NAV;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          {/*
            The context is passed rather than baked in, and it is undefined
            rather than an empty string when a client's name has not arrived —
            `Brand` then drops the separator entirely, instead of leaving a "·"
            dangling off the lockup for the length of the first load.
          */}
          <Brand ctx={isAdmin ? 'Admin' : client?.name} />

          <nav className="nav">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="account">
            <span className="whoami">{session?.user.email}</span>
            <ThemeToggle />
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                if (unsaved && unsaved.count > 0) unsaved.ask();
                else void signOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="main">{children}</main>

      <footer className="foot">
        {/*
          The lockup rather than the words, and `Brand` rather than a bare
          `Logo` so the footer inherits the same sizing rule as everywhere else.

          Worth knowing why this doesn't shout: the wordmark fills with
          `currentColor`, and `.foot` sets `--muted`, so ADOVIA ONE sits back at
          exactly the weight of the sentence beside it. The rocket keeps its
          gradient and does the whole job of being recognisable. Header-strength
          ink at the bottom of every page would compete with the page itself.

          The SVG carries `aria-label="Adovia One"`, so this reads the same to a
          screen reader as the text it replaces.
        */}
        <Brand />
        <span>
          Every figure here is entered by the Adovia team and stamped with when it was
          last updated.
        </span>
      </footer>
    </div>
  );
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {actions && <div className="pagehead-actions">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  aside,
  children,
  collapsible = false,
  defaultOpen = true,
  note,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  /** Renders as a `<details>` the reader can fold away. Needs a `title`. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /**
   * A short line held in the summary, visible whether the card is open or shut.
   *
   * This is the escape hatch for the one thing a collapsed card is bad at:
   * hiding something the reader needed to know about. A card that folds away
   * unsaved edits, or a warning, has to say so on the lid.
   */
  note?: ReactNode;
}) {
  if (collapsible && title) return <CollapsibleCard {...{ title, aside, children, defaultOpen, note }} />;

  return (
    <section className="card">
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A `<details>`, not a div and a button.
 *
 * The native element brings three things that are tedious and easy to get
 * subtly wrong by hand: the disclosure is keyboard-operable and announced as
 * one to a screen reader, its contents are inert while shut so Tab does not
 * walk into a table nobody can see, and — the one that actually matters here —
 * browser find-in-page opens a closed `<details>` when the match is inside it.
 * A hand-rolled panel that conditionally renders its children makes Ctrl-F
 * silently miss, which on a page of figures is a way to conclude a number is
 * absent when it is merely folded.
 *
 * `open` is held in state and pushed back from `onToggle` rather than passed as
 * a bare attribute. React re-syncs `open` on every render, and this card sits
 * on a grid that re-renders on every keystroke — passing it unmanaged snaps the
 * panel shut under the cursor as soon as anyone types.
 */
function CollapsibleCard({
  title,
  aside,
  children,
  defaultOpen,
  note,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  defaultOpen: boolean;
  note?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details className="card card-fold" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="card-head">
        <h2>{title}</h2>
        {note && <span className="card-note">{note}</span>}
      </summary>
      {/*
        `aside` sits BELOW the summary, not inside it. An aside is where callers
        put selects and buttons, and a control inside a `<summary>` toggles the
        panel when you click it — the month picker would close the card it
        belongs to. Below the lid it behaves, and it correctly disappears with
        the rest of the card when shut.
      */}
      {aside && <div className="card-head-aside">{aside}</div>}
      {children}
    </details>
  );
}

export function Empty({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="emptystate">
      <strong>{title}</strong>
      {body && <p className="muted">{body}</p>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}

/**
 * The dash a table cell shows for a figure nobody has stated.
 *
 * Shared rather than redeclared per page: "not entered" and "zero" have to look
 * different on every screen, and three private copies of this is three places
 * for one of them to quietly become a `0`.
 */
export function Blank() {
  return <span className="muted">—</span>;
}

/** A labelled figure. Null keeps its own rendering rather than collapsing to zero. */
export function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="figure">
      <div className="figure-label">{label}</div>
      {value === null ? (
        <div className="fig empty">Not yet entered</div>
      ) : (
        <div className="fig">{value}</div>
      )}
    </div>
  );
}
