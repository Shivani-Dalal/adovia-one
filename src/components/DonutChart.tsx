import type { ReactNode } from 'react';

export interface DonutSlice {
  /** Stable key — a campaign id, or a sentinel for the unattributed slice. */
  key: string;
  name: string;
  /** Always ≥ 0. A slice with nothing stated must not be passed in at all. */
  value: number;
  /** 1–5 for a campaign hue, or null for the neutral. See `campaignToner`. */
  tone: number | null;
}

/**
 * A share-of-total ring, for the one question a pie answers well.
 *
 * "How is this month's spend divided between campaigns" is a parts-of-a-whole
 * question at a single moment, with a handful of parts that genuinely sum to
 * the total — which is the narrow case a pie is the right chart for. It is
 * emphatically not a chart for change over time, and nothing here should ever
 * be given two of these side by side to compare: reading a change out of two
 * rings is something people are measurably bad at, and the line chart under it
 * on the Trend page exists to answer that question properly.
 *
 * A ring rather than a solid pie, because the hole is useful: it holds the
 * total, so the figure every slice is a share OF is inside the thing showing
 * the shares, instead of in a caption the reader has to hold in their head.
 *
 * The legend is a table, not a key. Angles are read badly — two slices a few
 * degrees apart are indistinguishable, and the difference between 18% and 22%
 * is invisible — so the exact figure and the exact share sit beside every
 * swatch. The ring is then doing what it is good at (showing that one campaign
 * dominates, at a glance) and the rows carry everything that needs precision.
 */
export function DonutChart({
  slices,
  total,
  centreLabel,
  format,
  caption,
}: {
  slices: DonutSlice[];
  /**
   * The figure the shares are of. Passed in rather than summed here, so this
   * cannot quietly disagree with the total printed elsewhere on the page — if
   * they differ, they differ visibly and somebody fixes the caller.
   */
  total: number;
  centreLabel: string;
  format: (n: number) => string;
  caption?: ReactNode;
}) {
  const drawable = slices.filter((s) => s.value > 0);

  // A ring needs a positive total to divide. A month where every campaign was
  // entered as zero is a real thing to be told about, and it is not a shape.
  if (drawable.length === 0 || total <= 0) {
    return <p className="muted">No spend to divide up in this window.</p>;
  }

  const SIZE = 240;
  const R = 92;
  const STROKE = 34;
  const c = SIZE / 2;
  const circumference = 2 * Math.PI * R;

  // Drawn as one circle per slice with a dash gap, rotated into place, rather
  // than as arc paths. Arcs need a large-arc flag whose edge cases (a single
  // slice at exactly 100%, a slice under a degree) are the ones that render as
  // an empty ring; a dash offset has no such cases.
  let offset = 0;
  const arcs = drawable.map((s) => {
    const fraction = s.value / total;
    const arc = { ...s, fraction, dash: fraction * circumference, offset };
    offset += arc.dash;
    return arc;
  });

  return (
    <figure className="donut">
      <div className="donut-body">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${centreLabel}, divided by campaign`}>
          {/*
            A track under the arcs. When the slices do not close the ring —
            which happens when a campaign's spend is stated but zero — the gap
            reads as part of the chart rather than as a rendering fault.
          */}
          <circle cx={c} cy={c} r={R} className="donut-track" strokeWidth={STROKE} />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={c}
              cy={c}
              r={R}
              className={a.tone === null ? 'donut-arc none' : `donut-arc t${a.tone}`}
              strokeWidth={STROKE}
              strokeDasharray={`${a.dash.toFixed(2)} ${(circumference - a.dash).toFixed(2)}`}
              strokeDashoffset={(-a.offset).toFixed(2)}
              // Rotated so the first slice starts at twelve o'clock. A ring
              // that starts at three reads as though it has been turned.
              transform={`rotate(-90 ${c} ${c})`}
            >
              <title>{`${a.name}: ${format(a.value)} (${(a.fraction * 100).toFixed(1)}%)`}</title>
            </circle>
          ))}
          <text x={c} y={c - 6} className="donut-total" textAnchor="middle">
            {format(total)}
          </text>
          <text x={c} y={c + 14} className="donut-sub" textAnchor="middle">
            {centreLabel}
          </text>
        </svg>

        <table className="donut-legend">
          <thead className="sr-only">
            <tr>
              <th>Campaign</th>
              <th>Spend</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {arcs.map((a) => (
              <tr key={a.key}>
                <th scope="row">
                  <span className={a.tone === null ? 'swatch none' : `swatch t${a.tone}`} />
                  {a.name}
                </th>
                <td className="num">{format(a.value)}</td>
                {/*
                  One decimal, because zero would round two different slices to
                  the same number and make the ring look mis-drawn. They still
                  need not sum to exactly 100 — rounding is rounding — which the
                  caption is expected to leave unclaimed rather than force.
                */}
                <td className="num muted">{(a.fraction * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {caption && <figcaption className="muted mt sm">{caption}</figcaption>}
    </figure>
  );
}
