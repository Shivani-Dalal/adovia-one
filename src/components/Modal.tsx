import { useEffect, useRef, type ReactNode } from 'react';

/**
 * What counts as somewhere focus can go.
 *
 * `:not([disabled])` matters more here than it looks. The importer's confirm
 * button is disabled until there is something to import, and the delete
 * confirmations disable their own buttons while the write is in flight — so the
 * set is different from one render to the next, and a list captured once would
 * send Tab to a control the browser refuses to focus. Every use below rebuilds
 * it at the moment it is needed.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The focusable elements of `root`, in tab order, minus the ones not rendered.
 *
 * `getClientRects().length` rather than `offsetParent !== null`: the latter is
 * the test everybody reaches for and it lies in two cases this app actually has
 * — a `position: fixed` element reports a null `offsetParent` while being
 * perfectly visible, and anything inside a shut `<details>` keeps a non-null
 * one, because `content-visibility: hidden` preserves the last layout it had.
 * An element that is genuinely not rendered has no client rects, and nothing
 * else does.
 */
function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /*
    `onClose` behind a ref, so the effect below can depend on nothing.

    Most callers pass an inline arrow — `onClose={() => setAdding(false)}` — so
    its identity changes on every render of the page underneath, and the effect
    used to tear down and re-run each time. That was already quietly wrong for
    the scroll lock: the re-run read back `document.body.style.overflow` as
    "hidden", which it had set itself a moment earlier, so the eventual close
    restored the page to "hidden" and left it unscrollable. It would be worse
    for the focus restore added below, whose whole job is to remember what was
    focused BEFORE the dialog opened — re-running mid-life would capture
    something inside the dialog and then try to focus it after it was gone.
  */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /*
    The control that opened this, so it can be handed focus back on close.

    Without it, closing a dialog drops focus to <body> and the next Tab restarts
    from the top of the document. For a keyboard user that means tabbing through
    the whole header and grid again to get back to the button they just pressed;
    for a screen reader it is worse than tedious, because nothing announces where
    they now are.

    Captured during RENDER rather than in the effect below, and the timing is the
    whole point. React applies `autoFocus` while it commits the DOM, which is
    before any passive effect runs — so by the time the effect fires, the three
    callers that set it (`NewCampaign`, `CampaignManager`, `ManageClients`) have
    already moved focus onto a field INSIDE the dialog. Reading
    `document.activeElement` there captured that field, and closing then tried to
    hand focus back to a node that had just been unmounted along with the dialog:
    `isConnected` was false, the restore was skipped, and focus fell to <body> —
    precisely the failure this exists to prevent. Render runs before the dialog
    is in the document at all, so what it sees is still the opener.

    The null check makes it a once-per-dialog capture. Renders keep happening
    while the dialog is open — every keystroke in a field causes one — and
    re-reading on any of them would overwrite the opener with whatever is focused
    inside.
  */
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    const node = ref.current;
    const opener = openerRef.current;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;

      /*
        The trap. `aria-modal="true"` tells a screen reader that everything
        outside this dialog is hidden, and Tab used to walk straight out of it
        into the daily entry grid — so an assistive-technology user could land
        in a field their software had just told them did not exist, and type a
        client's figures into it. Either the claim or the behaviour had to
        change, and the claim is the true one.
      */
      const items = focusable(node);

      // Nothing to land on: hold focus on the dialog itself rather than let Tab
      // out of it. The `tabIndex={-1}` below is what makes this possible.
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Focus already outside — a click on the page behind, or a control that
      // disappeared from under it. Pull it back, rather than assume it is
      // sitting on one of the two ends.
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);

    /*
      Move focus in, so the dialog is reachable by keyboard and screen readers
      land inside it rather than continuing down the page behind.

      Only when it is not in there already. `autoFocus` on a caller's own field
      has run by this point, and it is the more specific instruction: on "New
      campaign" the useful place to be is the name input, not the close button.
      Firing this unconditionally quietly undid all three of the callers that ask
      for it.

      Through the shared helper rather than a bare `querySelector`, so a first
      control that happens to be disabled cannot swallow the focus — `.focus()`
      on a disabled element does nothing at all, which would leave the cursor
      outside on the opener with a modal open in front of it.
    */
    if (node && !node.contains(document.activeElement)) {
      (focusable(node)[0] ?? node).focus();
    }

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;

      /*
        The dialog first. In development StrictMode runs this cleanup once on a
        dialog that is still on screen, purely to prove the effect can be torn
        down and built again — nothing has closed. Restoring focus there would
        pull the cursor out of a dialog the user is looking at, and the re-run
        would drop it back on the close button rather than the field `autoFocus`
        chose, so development would behave differently from production for no
        reason at all. A cleanup worth acting on is one where the dialog has gone.

        Then the opener, because it is not always still there either. Deleting a
        campaign from the manage list unmounts the row whose button opened the
        confirmation. Focusing a detached node is silently a no-op rather than an
        error, and the guard keeps that case deliberate rather than accidental.
      */
      if (node?.isConnected) return;
      if (opener?.isConnected) opener.focus();
    };
    // Runs once for the life of the dialog. See the note on `onCloseRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        /*
          Only so the trap has somewhere to park focus in the rare case that the
          dialog holds no focusable control at all. -1 keeps it out of the tab
          order, so it never becomes a stop on the way round.
        */
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost sm icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
