import { compact } from '../lib/format';
import { formatDate, type ISODate } from '../lib/dates';

export interface TrendSeries {
  key: string;
  name: string;
  /** 1–5 for a campaign hue, null for the neutral, 'accent' for the one-line case. */
  tone: number | null | 'accent';
  /** One entry per date, same length and order as `dates`. Null means not entered. */
  values: (number | null)[];
}

/**
 * Hand-rolled SVG rather than a charting library.
 *
 * The reason is the null handling, not the bundle size. Every chart library's
 * default is to interpolate across missing points, which draws a smooth line
 * through days Adovia never entered — the single thing this product must not
 * do. Here a null simply breaks the path, and the gap is visible.
 *
 * ONE VALUE AXIS, and this is load-bearing. This chart used to plot rupees and
 * admissions together against two different scales, which is a chart that can
 * be made to tell any story you like: the two axes are independently
 * scaleable, so where the lines cross — and therefore which one appears to be
 * "ahead" — is an artefact of the maximums rather than a fact about the
 * client's month. The fix is not a better second axis, it is a second chart:
 * two of these stacked under a shared date axis let a reader compare shapes
 * without the drawing having implied a relationship nobody measured.
 */
export function TrendChart({
  dates,
  series,
  label,
  format,
  emptyText,
}: {
  dates: ISODate[];
  series: TrendSeries[];
  /** What the value axis measures, for the accessible name and the y-axis. */
  label: string;
  format: (n: number) => string;
  emptyText?: string;
}) {
  const W = 720;
  const H = 220;
  const PAD = { top: 14, right: 16, bottom: 26, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;

  const stated = series.flatMap((s) => s.values).filter((n): n is number => n !== null);

  if (dates.length === 0 || stated.length === 0) {
    return <p className="muted">{emptyText ?? 'No figures recorded in this window.'}</p>;
  }

  // Zero-based, always. A chart scaled to its own minimum turns a 4% wobble
  // into a cliff, and this is a page a client reads for shape — the shape has
  // to be the money's shape rather than the axis's.
  const max = Math.max(1, ...stated);

  const x = (i: number) => PAD.left + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;

  // One path per unbroken run of stated points. Runs of length 1 get a dot
  // instead, so a single entry surrounded by gaps is still visible.
  function runs(values: (number | null)[]) {
    const out: { d: string; single: [number, number] | null }[] = [];
    let cur: [number, number][] = [];

    const flush = () => {
      if (cur.length === 1) out.push({ d: '', single: cur[0] });
      else if (cur.length > 1) {
        out.push({
          d: cur
            .map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
            .join(' '),
          single: null,
        });
      }
      cur = [];
    };

    values.forEach((v, i) => {
      if (v === null) flush();
      else cur.push([x(i), y(v)]);
    });
    flush();
    return out;
  }

  const toneClass = (t: TrendSeries['tone']) =>
    t === 'accent' ? 'accent' : t === null ? 'none' : `t${t}`;

  /**
   * A dash pattern per series, so two lines that coincide stay legible.
   *
   * Colour alone fails in the exact case it is most needed. Where two campaigns
   * report the same figure for a stretch of days, their paths are identical to
   * the pixel and the one drawn second paints over the first completely — the
   * reader sees ONE line and concludes the other campaign has no data, which is
   * the worst available misreading because it looks like a confident answer
   * rather than a rendering fault.
   *
   * That is not only a symptom of bad data. Two campaigns splitting one budget
   * evenly, or a client whose spend is capped at the same daily figure across
   * placements, will genuinely coincide. So the drawing has to survive it.
   *
   * Applied only when there is more than one line: a lone series has nothing to
   * be confused with, and a dashed single line reads as though the dashes mean
   * something. The pattern also doubles as the redundant encoding that makes
   * this readable on a mono printout and to a reader who cannot separate the
   * hues.
   */
  const dashClass = (i: number) => (series.length > 1 ? ` d${i % 5}` : '');

  // Label the ends and the middle only; thirty dates along an axis is noise.
  const ticks = [0, Math.floor((dates.length - 1) / 2), dates.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i && v >= 0,
  );

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} by date`}>
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + ih * f}
            y2={PAD.top + ih * f}
            className="grid"
          />
        ))}

        {[0, 0.5, 1].map((f) => (
          <text key={`l${f}`} x={PAD.left - 8} y={PAD.top + ih * f + 4} className="axis right">
            {compact(max * (1 - f))}
          </text>
        ))}

        {series.map((s, si) =>
          runs(s.values).map((r, i) =>
            r.single ? (
              <circle
                key={`${s.key}-${i}`}
                cx={r.single[0]}
                cy={r.single[1]}
                r={2.5}
                // No dash class here. A dot is a fill, and a 2.5px circle
                // carrying a dash pattern renders as three commas. Two dots
                // that coincide do still hide each other, which the legend and
                // the sr-only table both disambiguate — unlike a hidden LINE,
                // which is a whole series silently absent from the picture.
                className={`dot ${toneClass(s.tone)}`}
              />
            ) : (
              <path
                key={`${s.key}-${i}`}
                d={r.d}
                className={`line ${toneClass(s.tone)}${dashClass(si)}`}
              />
            ),
          ),
        )}

        {ticks.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 8}
            className="axis mid"
            textAnchor={i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}
          >
            {formatDate(dates[i])}
          </text>
        ))}
      </svg>

      {/*
        No legend when there is one line. The card title already says what it
        is, and a key with a single entry is a label pretending to be a control.
      */}
      {series.length > 1 && (
        <div className="legend">
          {/*
            The key carries the dash pattern as well as the colour. A legend
            that showed five solid swatches against five dashed lines would be
            a key to a different chart.
          */}
          {series.map((s, si) => (
            <span key={s.key} className={`key ${toneClass(s.tone)}${dashClass(si)}`}>
              {s.name}
            </span>
          ))}
        </div>
      )}

      <table className="sr-only">
        <caption>{label} by date</caption>
        <thead>
          <tr>
            <th>Date</th>
            {series.map((s) => (
              <th key={s.key}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((d, i) => (
            <tr key={d}>
              <td>{formatDate(d)}</td>
              {series.map((s) => (
                <td key={s.key}>
                  {s.values[i] === null ? 'Not entered' : format(s.values[i] as number)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
