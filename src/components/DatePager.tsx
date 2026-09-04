import { addDays, formatDate, type ISODate } from '../lib/dates';

/**
 * Date selection for the client overview.
 *
 * Three affordances, because a bare `<input type="date">` is wrong on its own:
 * stepping back a day is the common action and shouldn't require opening a
 * calendar, and once a client has paged away there must be one obvious way
 * back to the newest figures.
 *
 * `min` and `max` are real bounds, not decoration. `min` is the client's first
 * recorded day and `max` is the server's business day — nobody browses into
 * blank months before their account existed, or into the future.
 *
 * Note that arrows step by one calendar day and may land on a day with no
 * entry. That is deliberate: skipping to the previous day that *has* data would
 * hide the gaps, and the gaps are information.
 */
export function DatePager({
  value,
  min,
  max,
  latest,
  busy,
  onChange,
}: {
  value: ISODate;
  min: ISODate;
  max: ISODate;
  latest: ISODate;
  busy?: boolean;
  onChange: (d: ISODate) => void;
}) {
  const prev = addDays(value, -1);
  const next = addDays(value, 1);

  const canPrev = prev >= min; // ISO dates compare correctly as strings.
  const canNext = next <= max;

  return (
    <div className="datepager">
      <button
        type="button"
        className="btn ghost sm icon"
        onClick={() => onChange(prev)}
        disabled={!canPrev || busy}
        aria-label={`Previous day, ${formatDate(prev)}`}
        title={canPrev ? formatDate(prev) : `Nothing recorded before ${formatDate(min)}`}
      >
        ‹
      </button>

      <label className="sr-only" htmlFor="datepick">
        Show figures for date
      </label>
      <input
        id="datepick"
        type="date"
        className="dateinput"
        value={value}
        min={min}
        max={max}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value;
          // Browsers hand back '' when the field is cleared. Clearing is not a
          // state this screen has, so treat it as a no-op.
          if (v && v >= min && v <= max) onChange(v);
        }}
      />

      <button
        type="button"
        className="btn ghost sm icon"
        onClick={() => onChange(next)}
        disabled={!canNext || busy}
        aria-label={`Next day, ${formatDate(next)}`}
        title={canNext ? formatDate(next) : 'Today is the last day available'}
      >
        ›
      </button>

      {value !== latest && (
        <button type="button" className="btn ghost sm" onClick={() => onChange(latest)}>
          Latest
        </button>
      )}
    </div>
  );
}
