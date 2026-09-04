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
 *
 * No freshness stamp. This used to carry "Updated 15 minutes ago by Adovia"
 * under every figure, which answered a question clients were not asking and
 * raised one they were not meant to: how long ago Adovia last touched their
 * account. The date the figures are *for* is stated once at the foot of the
 * page, which is the thing that actually needs to be unambiguous. When the row
 * was typed is our business, and it is still on the admin side where it
 * belongs.
 */
export function Figure({
  label,
  value,
  format,
  hero = false,
}: {
  label: string;
  value: number | null;
  format: (n: number | null) => string | null;
  hero?: boolean;
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
    </div>
  );
}
