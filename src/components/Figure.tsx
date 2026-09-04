import { relativeTime, formatTimestamp } from '../lib/dates';

/**
 * The component the whole product's claim rests on.
 *
 * A number Adovia has stated and a number Adovia has not stated must not look
 * the same. So `value === null` renders a visibly different, dashed "Not yet
 * entered" state — never a zero, never an em dash, never a blank that reads as
 * "your campaign did nothing".
 *
 * The formatter is passed in and returns `string | null`, which is what makes
 * this hard to get wrong: there is no path where a caller formats a null into
 * "₹0" before it reaches here.
 */
export function Figure({
  label,
  value,
  format,
  hero = false,
  updatedAt,
  by = 'Adovia',
}: {
  label: string;
  value: number | null;
  format: (n: number | null) => string | null;
  hero?: boolean;
  updatedAt?: string | null;
  by?: string;
}) {
  const text = format(value);
  const stated = text !== null;

  return (
    <div className="figure">
      <div className="figure-label">{label}</div>

      {stated ? (
        <div className={hero ? 'fig hero' : 'fig'}>{text}</div>
      ) : (
        <div className="fig empty" title="Adovia has not entered this figure yet">
          Not yet entered
        </div>
      )}

      {stated && updatedAt && (
        <div className="stamp" title={formatTimestamp(updatedAt)}>
          Updated {relativeTime(updatedAt)} by {by}
        </div>
      )}
    </div>
  );
}
