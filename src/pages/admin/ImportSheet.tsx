import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import { ErrorNote } from '../../components/Shell';
import { readSheets, sheetErrorText, type Grid } from '../../lib/sheet';
import { formatDate, type ISODate } from '../../lib/dates';
import { money, count } from '../../lib/format';
import { campaignWriteError } from '../../lib/campaigns';
import {
  IMPORT_FIELDS,
  buildPlan,
  guessHeaderRow,
  guessMapping,
  inferDateStyle,
  payloadFor,
  type CampaignSource,
  type DateStyle,
  type ImportField,
  type Mapping,
  type Plan,
  type PlannedRow,
} from '../../lib/importReport';
import {
  REPORT_COLS,
  REPORT_LABELS,
  rows as asRows,
  UNATTRIBUTED,
  type Campaign,
  type Client,
  type DailyReport,
} from '../../lib/types';

/**
 * Loading a month of figures from the spreadsheet ops already keeps.
 *
 * The daily grid is built for one day at a time, which is the right shape for
 * the day it happens on and the wrong shape for the client who sends a month in
 * one file. Retyping thirty rows into a grid is where transposed digits come
 * from, and this screen exists to remove that step rather than to add a feature.
 *
 * NOTHING IS WRITTEN UNTIL THE LAST BUTTON. Everything before it — the reading,
 * the mapping, the plan — happens in the browser against rows already fetched,
 * so ops can point this at the wrong file, see it say so, and change it. The
 * preview is not a courtesy: an import is the one action here that can touch a
 * hundred client-facing figures at once, and the difference between a good
 * import and a bad one is entirely in whether the columns were understood.
 *
 * The screen is a queue of questions, in the order they can be answered, and
 * each one only appears once the one above it has an answer:
 *
 *   client → file → sheet → header row → columns → date convention → plan
 *
 * The two the file cannot answer for itself are the ones ops is asked about
 * loudest. Which column is which is guessed from the headings and shown as
 * correctable dropdowns. Whether `03/09` is March or September is *proved* from
 * the file where the file contains a proof, and asked plainly where it does not
 * — see `inferDateStyle`. A quiet default there would land a month of figures on
 * the wrong days with every row looking perfectly fine.
 */

/** How many rows of the file to show while picking the header row. */
const PEEK_ROWS = 8;
/** How many planned rows the preview lists before summarising the rest. */
const PREVIEW_ROWS = 60;

const STATUS_LABEL: Record<PlannedRow['status'], string> = {
  new: 'New',
  changed: 'Changed',
  unchanged: 'Already matches',
  blank: 'No figures',
  blocked: 'Cannot import',
};

/** A figure as the preview should print it — money for spend, plain otherwise. */
function figureText(field: ImportField, n: number | null): string {
  if (n === null) return '—';
  return (field === 'ad_spend' ? money(n) : count(n)) ?? '—';
}

export function ImportSheet({
  clients,
  initialClientId,
  maxDate,
  onClose,
  onImported,
}: {
  /** The clients on the grid, in the grid's own order. */
  clients: Client[];
  initialClientId?: string;
  /** The latest date that may be written — the server's business day. */
  maxDate: ISODate;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? clients[0]?.id ?? '');

  const [grids, setGrids] = useState<Grid[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [reading, setReading] = useState(false);

  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({
    date: null,
    campaign: { kind: 'none' },
    fields: {},
  });
  const [dateStyle, setDateStyle] = useState<DateStyle>('dmy');
  /** True once ops has chosen a convention, or the file proved one itself. */
  const [styleSettled, setStyleSettled] = useState(true);

  /** Campaign names in the file that this client lacks, opted into creating. */
  const [createNames, setCreateNames] = useState<ReadonlySet<string>>(new Set());

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [existing, setExisting] = useState<DailyReport[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grid = grids?.[sheetIndex] ?? null;
  const header = useMemo(() => grid?.cells[headerRow] ?? [], [grid, headerRow]);

  /*
    Reset the mapping whenever the sheet under it changes. Keeping column
    indexes across a sheet switch is the subtle version of the bug this whole
    screen guards against: the numbers would still line up in a plausible way,
    just under the wrong headings.
  */
  const remap = useCallback((g: Grid, row: number) => {
    setHeaderRow(row);
    setMapping(guessMapping(g.cells[row] ?? []));
    setCreateNames(new Set());
  }, []);

  async function pickFile(file: File) {
    setError(null);
    setReading(true);
    try {
      const read = await readSheets(file);
      setGrids(read);
      setFileName(file.name);
      setSheetIndex(0);
      const row = guessHeaderRow(read[0].cells);
      remap(read[0], row);
    } catch (e) {
      setGrids(null);
      setError(sheetErrorText(e));
    } finally {
      setReading(false);
    }
  }

  function pickSheet(i: number) {
    if (!grids) return;
    setSheetIndex(i);
    remap(grids[i], guessHeaderRow(grids[i].cells));
  }

  /*
    The date convention, decided by the file where the file can decide it.

    Runs on the date column rather than on ops' opinion, and only asks when the
    file contains no day past the twelfth to prove it either way. `conflict`
    means both proofs appear in one column — 13/09 and 09/13 together — which is
    not an ambiguity to resolve but a broken file to send back.
  */
  const dateColumn = mapping.date;
  const styleGuess = useMemo(() => {
    if (!grid || dateColumn === null) return null;
    return inferDateStyle(
      grid.cells.slice(headerRow + 1).map((r) => r[dateColumn] ?? ''),
    );
  }, [grid, headerRow, dateColumn]);

  useEffect(() => {
    if (!styleGuess) return;
    setDateStyle(styleGuess.style);
    setStyleSettled(styleGuess.certain);
  }, [styleGuess]);

  /*
    What is already stored, for the dates this file touches.

    Fetched on the file's own range rather than the whole client, so re-running
    a March file does not drag down a year of rows to compare four weeks
    against. It is what turns "write these rows" into "these three would change,
    these forty already match".
  */
  const range = useMemo(() => {
    if (!grid || dateColumn === null) return null;
    const plan = buildPlan({
      cells: grid.cells,
      headerRow,
      mapping,
      dateStyle,
      campaigns: [],
      existing: [],
      maxDate,
    });
    if (plan.dates.length === 0) return null;
    return { from: plan.dates[0], to: plan.dates[plan.dates.length - 1] };
  }, [grid, headerRow, mapping, dateStyle, dateColumn, maxDate]);

  const rangeKey = range ? `${range.from}:${range.to}` : '';

  /*
    This client's campaigns, on the client alone.

    Separate from the rows fetch below, which waits for a file to have a date
    range. These are needed before any file is chosen, because "every row is
    this campaign" is one of the answers to the campaign question and the list
    has to be on screen to be picked from. Fetching them alongside the rows
    would mean the choice only appeared after a file with a readable date
    column had been loaded — which is the wrong way round, since choosing the
    campaign is how you make a file without a campaign column readable.
  */
  useEffect(() => {
    if (clientId === '') return;
    let live = true;

    void (async () => {
      const { data, error: err } = await supabase
        .from('campaigns')
        .select('*')
        .eq('client_id', clientId)
        .order('name');
      if (!live) return;
      if (err) setError(errorText(err));
      else setCampaigns(asRows<Campaign>(data));
    })();

    return () => {
      live = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (clientId === '' || rangeKey === '') return;
    const [from, to] = rangeKey.split(':');
    let live = true;

    void (async () => {
      setLoadingRows(true);
      const { data, error: err } = await supabase
        .from('daily_report')
        .select(REPORT_COLS)
        .eq('client_id', clientId)
        .gte('date', from)
        .lte('date', to);
      if (!live) return;
      if (err) setError(errorText(err));
      else setExisting(asRows<DailyReport>(data));
      setLoadingRows(false);
    })();

    // A file switched mid-fetch must not have the previous file's rows land on
    // it. Without this the plan would compare the new sheet against the old
    // range and report changes that are an artefact of the race.
    return () => {
      live = false;
    };
  }, [clientId, rangeKey]);

  const plan: Plan | null = useMemo(() => {
    if (!grid || dateColumn === null || loadingRows) return null;
    return buildPlan({
      cells: grid.cells,
      headerRow,
      mapping,
      dateStyle,
      campaigns,
      existing,
      maxDate,
      willCreate: createNames,
    });
  }, [
    grid, headerRow, mapping, dateStyle, campaigns, existing, maxDate, createNames,
    dateColumn, loadingRows,
  ]);

  const mappedFields = IMPORT_FIELDS.filter((f) => mapping.fields[f] !== undefined);
  const writable = plan ? plan.counts.new + plan.counts.changed : 0;
  const client = clients.find((c) => c.id === clientId);

  /** Names still to be created, in the order the file first mentions them. */
  const toCreate = plan ? plan.unknownCampaigns.filter((n) => createNames.has(n.trim().toLowerCase())) : [];

  async function commit() {
    if (!plan || !client || writable === 0) return;
    setBusy(true);
    setError(null);

    /*
      Campaigns first, and their new ids read back before a single figure is
      written. A figure whose campaign does not exist yet cannot be attributed,
      and writing the rows first would either fail on the foreign key or land
      them on the unattributed line — which looks like a successful import and
      is not one.
    */
    const created = new Map<string, string>();
    if (toCreate.length > 0) {
      const { data, error: err } = await supabase
        .from('campaigns')
        .insert(toCreate.map((name) => ({ client_id: client.id, name })))
        .select('id, name');

      if (err) {
        setBusy(false);
        setError(campaignWriteError(err));
        return;
      }
      for (const c of asRows<{ id: string; name: string }>(data)) {
        created.set(c.name.trim().toLowerCase(), c.id);
      }

      // Every name must have come back with an id. `payloadFor` resolves an
      // unknown name to null, which is the unattributed line — so a short
      // insert would not fail, it would quietly file a campaign's figures
      // under "no campaign" and report a successful import. Stopping here
      // leaves the campaigns created and no figures written, which is the
      // state ops can see and re-run from.
      const missing = toCreate.filter((n) => !created.has(n.trim().toLowerCase()));
      if (missing.length > 0) {
        setBusy(false);
        setError(
          `Created the campaigns but could not read back ${missing
            .map((n) => `“${n}”`)
            .join(', ')}. No figures were written. Check Campaigns on this client, then import again.`,
        );
        return;
      }
    }

    const payload = payloadFor(plan.rows, client.id, (name) =>
      created.get(name.trim().toLowerCase()) ?? null,
    );

    // The same conflict target the grid saves on, so a row imported here and a
    // row typed there are the same UPDATE and fire the same history trigger.
    const { error: err } = await supabase
      .from('daily_report')
      .upsert(payload, { onConflict: 'client_id,campaign_id,date' });

    setBusy(false);
    if (err) {
      setError(errorText(err));
      return;
    }

    const parts = [`${payload.length} row${payload.length === 1 ? '' : 's'}`];
    if (toCreate.length > 0) {
      parts.push(`${toCreate.length} new campaign${toCreate.length === 1 ? '' : 's'}`);
    }
    onImported(`Imported ${parts.join(' and ')} for ${client.name}.`);
  }

  return (
    <Modal title="Import from a spreadsheet" onClose={onClose} wide>
      <p className="muted">
        Reads an .xlsx or .csv file and loads it into this client&rsquo;s daily figures,
        split by campaign. Nothing is written until you confirm the preview at the bottom.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="field mt">
        <label htmlFor="importclient">Client</label>
        <select
          id="importclient"
          value={clientId}
          disabled={busy}
          onChange={(e) => {
            setClientId(e.target.value);
            // Campaign names are per client, so an opt-in to create "PR" for
            // one client must not follow the file to the next.
            setCreateNames(new Set());
            // Nor may a fixed campaign: it is one client's campaign by id, and
            // carried across it would name a campaign the new client does not
            // have. Cleared rather than remapped, because there is no such
            // thing as the same campaign on a different client.
            setMapping((m) =>
              m.campaign.kind === 'fixed' ? { ...m, campaign: { kind: 'none' } } : m,
            );
            // Dropped so the picker cannot offer the previous client's
            // campaigns in the gap before the new ones arrive.
            setCampaigns([]);
          }}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <FilePick busy={busy || reading} onPick={pickFile} />

      {reading && <p className="muted">Reading {fileName}…</p>}

      {grids && grid && (
        <>
          {grids.length > 1 && (
            <div className="field mt">
              <label htmlFor="importsheet">Sheet</label>
              <select
                id="importsheet"
                value={sheetIndex}
                disabled={busy}
                onChange={(e) => pickSheet(Number(e.target.value))}
              >
                {grids.map((g, i) => (
                  <option key={g.name + i} value={i}>
                    {g.name} ({Math.max(0, g.cells.length - 1)} rows)
                  </option>
                ))}
              </select>
            </div>
          )}

          <HeaderPick
            grid={grid}
            headerRow={headerRow}
            busy={busy}
            onPick={(r) => remap(grid, r)}
          />

          <ColumnMap
            header={header}
            mapping={mapping}
            campaigns={campaigns}
            busy={busy}
            onChange={setMapping}
          />

          {mapping.date === null ? (
            <p className="hint mt">
              <strong className="warn">Tell it which column holds the date.</strong> Without
              one there is nothing to say which day each row belongs to.
            </p>
          ) : mappedFields.length === 0 ? (
            <p className="hint mt">
              <strong className="warn">No figure columns are mapped.</strong> Pick at least
              one — spend, impressions or a projection — or there is nothing to import.
            </p>
          ) : null}

          {styleGuess && mapping.date !== null && (
            <DateConvention
              guess={styleGuess}
              style={dateStyle}
              settled={styleSettled}
              busy={busy}
              sample={
                grid.cells
                  .slice(headerRow + 1)
                  .map((r) => r[mapping.date as number] ?? '')
                  .find((s) => s.trim() !== '') ?? ''
              }
              onChoose={(s) => {
                setDateStyle(s);
                setStyleSettled(true);
              }}
            />
          )}

          {loadingRows && <p className="muted mt">Checking what is already recorded…</p>}

          {plan && styleSettled && mapping.date !== null && (
            <>
              {plan.unknownCampaigns.length > 0 && (
                <UnknownCampaigns
                  names={plan.unknownCampaigns}
                  chosen={createNames}
                  clientName={client?.name ?? ''}
                  busy={busy}
                  onToggle={(name) => {
                    const key = name.trim().toLowerCase();
                    const next = new Set(createNames);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    setCreateNames(next);
                  }}
                />
              )}

              <Preview plan={plan} fields={mappedFields} />

              <div className="modal-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || writable === 0}
                  onClick={() => void commit()}
                >
                  {busy
                    ? 'Importing…'
                    : writable === 0
                      ? 'Nothing to import'
                      : `Import ${writable} row${writable === 1 ? '' : 's'}`}
                </button>
              </div>

              {plan.counts.blocked > 0 && (
                <p className="hint sm">
                  The {plan.counts.blocked} row{plan.counts.blocked === 1 ? '' : 's'} marked
                  &ldquo;cannot import&rdquo; will be skipped. Fix them in the file and import
                  again — importing twice is safe, rows that already match are left alone.
                </p>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- file --- */

function FilePick({ busy, onPick }: { busy: boolean; onPick: (f: File) => void }) {
  return (
    <div className="field">
      <label htmlFor="importfile">Spreadsheet</label>
      <input
        id="importfile"
        type="file"
        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          // Cleared so picking the same filename twice still fires a change.
          // Re-picking a file you have just corrected in Excel is the common
          // case here, and silently ignoring it would look like a hung screen.
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- header --- */

/**
 * Which row holds the headings, shown as the file's own first rows.
 *
 * Guessed, then made visible. Sheets that come from a person rather than a
 * platform routinely open with a title row, a blank, and then the headings, and
 * a guess that lands one row out maps every column to the wrong name — so the
 * fix has to be reachable without leaving the screen.
 */
function HeaderPick({
  grid,
  headerRow,
  busy,
  onPick,
}: {
  grid: Grid;
  headerRow: number;
  busy: boolean;
  onPick: (row: number) => void;
}) {
  const peek = grid.cells.slice(0, Math.max(PEEK_ROWS, headerRow + 2));

  return (
    <div className="mt">
      <p className="label">Which row has the column headings?</p>
      <div className="tablewrap">
        <table className="table sheetpeek">
          <tbody>
            {peek.map((row, i) => (
              <tr key={i} className={i === headerRow ? 'picked' : undefined}>
                <td className="pickcell">
                  <label>
                    <input
                      type="radio"
                      name="headerrow"
                      checked={i === headerRow}
                      disabled={busy}
                      onChange={() => onPick(i)}
                      aria-label={`Row ${i + 1} holds the headings`}
                    />{' '}
                    {i + 1}
                  </label>
                </td>
                {row.slice(0, 10).map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- column --- */

/**
 * What each column of the file means, guessed and correctable.
 *
 * One dropdown per importable field rather than one per column of the file,
 * because the question ops can answer is "where is the spend?" and not "what is
 * column G?". Columns nobody picks are ignored — a sheet full of totals,
 * formulas and a notes column imports fine without anybody deleting them first.
 */
function ColumnMap({
  header,
  mapping,
  campaigns,
  busy,
  onChange,
}: {
  header: readonly string[];
  mapping: Mapping;
  /** This client's campaigns, so the whole file can be assigned to one. */
  campaigns: readonly Campaign[];
  busy: boolean;
  onChange: (m: Mapping) => void;
}) {
  const label = (i: number) => {
    const h = header[i]?.trim();
    return h && h !== '' ? `${colName(i)} · ${h}` : `${colName(i)} · (no heading)`;
  };

  // Bound once so the union stays narrowed: a call in the middle of the check
  // below (`guessMapping`) resets narrowing on a property access, but not on a
  // const.
  const source = mapping.campaign;
  const fileNamesCampaigns = guessMapping(header).campaign.kind === 'column';

  const options = header.map((_, i) => (
    <option key={i} value={i}>
      {label(i)}
    </option>
  ));

  return (
    <div className="mt">
      <p className="label">Which column is which?</p>
      <div className="mapgrid">
        <div className="field">
          <label htmlFor="map-date">Date</label>
          <select
            id="map-date"
            value={mapping.date ?? ''}
            disabled={busy}
            onChange={(e) =>
              onChange({ ...mapping, date: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            <option value="">Not in this file</option>
            {options}
          </select>
        </div>

        {/*
          Three answers, not two, because a file legitimately arrives in three
          shapes: one that names a campaign per row, one that IS a campaign and
          says so only in its filename, and one for a client who is not split at
          all. Only the first and last were expressible before, so the middle
          case — much the most common, since ops exports a month per campaign —
          had to be forced into the first by adding a column to the file by
          hand. That is an edit to the source document, made in a hurry,
          immediately before a bulk write of client-facing figures.
        */}
        <div className="field">
          <label htmlFor="map-campaign">Campaign</label>
          <select
            id="map-campaign"
            value={
              source.kind === 'column'
                ? `col:${source.at}`
                : source.kind === 'fixed'
                  ? `id:${source.id}`
                  : ''
            }
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              const campaign: CampaignSource = v.startsWith('col:')
                ? { kind: 'column', at: Number(v.slice(4)) }
                : v.startsWith('id:')
                  ? { kind: 'fixed', id: v.slice(3) }
                  : { kind: 'none' };
              onChange({ ...mapping, campaign });
            }}
          >
            {/*
              Not an error. A file with no campaign column is a client who is
              not split, and every row lands on the unattributed line — the same
              line the grid shows them.
            */}
            <option value="">Not in this file — one line for the client</option>
            {campaigns.length > 0 && (
              <optgroup label="Every row in this file is one campaign">
                {campaigns.map((c) => (
                  <option key={c.id} value={`id:${c.id}`}>
                    All rows → {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="A column in the file names the campaign">
              {header.map((_, i) => (
                <option key={i} value={`col:${i}`}>
                  {label(i)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        {IMPORT_FIELDS.map((f) => (
          <div className="field" key={f}>
            <label htmlFor={`map-${f}`}>{REPORT_LABELS[f]}</label>
            <select
              id={`map-${f}`}
              value={mapping.fields[f] ?? ''}
              disabled={busy}
              onChange={(e) => {
                const fields = { ...mapping.fields };
                if (e.target.value === '') delete fields[f];
                else fields[f] = Number(e.target.value);
                onChange({ ...mapping, fields });
              }}
            >
              <option value="">Not in this file</option>
              {options}
            </select>
          </div>
        ))}
      </div>
      {/*
        The one way this control can quietly do the wrong thing: the file names
        campaigns per row AND ops has assigned the whole file to one. Every row
        then lands on the chosen campaign and the file's own column is ignored,
        which looks like a clean import of a month onto a single campaign. Said
        out loud, because nothing downstream of here can tell it from correct.
      */}
      {source.kind === 'fixed' && fileNamesCampaigns && (
        <p className="hint mt">
          <strong className="warn">This file looks like it names campaigns itself.</strong>{' '}
          Every row will be imported as{' '}
          <strong>
            {campaigns.find((c) => c.id === source.id)?.name ?? 'the chosen campaign'}
          </strong>{' '}
          and that column ignored. If the file covers more than one campaign, pick the column
          instead — check the Campaign column in the preview below before importing.
        </p>
      )}

      <p className="hint sm">
        A column left as &ldquo;not in this file&rdquo; is not imported and never
        overwrites what is already recorded. Neither does a blank cell — an import can
        add and correct figures, but it cannot clear one.
      </p>
    </div>
  );
}

/** A1-style column name, so the dropdown matches what Excel shows. */
function colName(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* ----------------------------------------------------------------- date --- */

/**
 * Day-first or month-first, proved where possible and asked where not.
 *
 * This is the most dangerous question on the screen and the one with the least
 * to show for it. Every other mistake announces itself — a wrong column puts
 * impressions in the spend field and the preview looks absurd. This one puts
 * every figure on a plausible wrong day, and there is nothing on any screen
 * afterwards that looks wrong.
 */
function DateConvention({
  guess,
  style,
  settled,
  busy,
  sample,
  onChoose,
}: {
  guess: { style: DateStyle; certain: boolean; conflict: boolean };
  style: DateStyle;
  settled: boolean;
  busy: boolean;
  sample: string;
  onChoose: (s: DateStyle) => void;
}) {
  if (guess.conflict) {
    return (
      <p className="hint mt">
        <strong className="warn">This file mixes both date conventions.</strong> Some rows
        can only be day/month and others can only be month/day, so there is no reading of
        the column that is right for all of them. Fix the dates in the file and try again.
      </p>
    );
  }

  if (guess.certain) {
    return (
      <p className="hint mt">
        Dates read as{' '}
        <strong>{style === 'dmy' ? 'day/month/year' : 'month/day/year'}</strong> — the file
        proves it{sample ? <> (e.g. {sample})</> : null}.
      </p>
    );
  }

  return (
    <div className="mt">
      <p className="label">Is {sample || 'the date column'} day/month or month/day?</p>
      <p className="hint sm">
        Every date in this file works read either way, so it cannot tell. Getting this wrong
        puts the whole file on the wrong days without anything looking out of place
        afterwards — check the file before choosing.
      </p>
      <div className="rowbtns">
        <button
          type="button"
          className={`btn sm${settled && style === 'dmy' ? '' : ' ghost'}`}
          disabled={busy}
          onClick={() => onChoose('dmy')}
        >
          Day/month (03/09 is 3 September)
        </button>{' '}
        <button
          type="button"
          className={`btn sm${settled && style === 'mdy' ? '' : ' ghost'}`}
          disabled={busy}
          onClick={() => onChoose('mdy')}
        >
          Month/day (03/09 is 9 March)
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ campaigns --- */

/**
 * Names the file mentions that this client does not have.
 *
 * Opt-in per name, never automatic. A typo in the file — "Goggle Ads" — and a
 * campaign that genuinely started this month look identical from here, and only
 * one of them should become a permanent row in the client's breakdown. Creating
 * them silently would fill the client's report with near-duplicate headings
 * nobody can tell apart afterwards.
 */
function UnknownCampaigns({
  names,
  chosen,
  clientName,
  busy,
  onToggle,
}: {
  names: readonly string[];
  chosen: ReadonlySet<string>;
  clientName: string;
  busy: boolean;
  onToggle: (name: string) => void;
}) {
  return (
    <div className="mt">
      <p className="label">
        {names.length} campaign name{names.length === 1 ? '' : 's'} in this file that{' '}
        {clientName} does not have
      </p>
      <p className="hint sm">
        Tick the ones to create. Unticked names are skipped along with their rows — which is
        the right answer for a misspelling. Names are matched ignoring case and spacing, so
        this list is only names that are genuinely new.
      </p>
      <ul className="plain">
        {names.map((n) => (
          <li key={n}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(n.trim().toLowerCase())}
                disabled={busy}
                onChange={() => onToggle(n)}
              />{' '}
              Create &ldquo;{n}&rdquo;
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- preview --- */

/**
 * What the import would do, row by row.
 *
 * Shows all five states including the ones that will not be written. "41
 * already match" is the sentence that tells ops they are re-running a file they
 * have already imported, which is otherwise indistinguishable from an import
 * that silently did nothing.
 *
 * Changed rows print the old figure struck through beside the new one. A bulk
 * write over client-facing history should not be confirmable without seeing
 * what it replaces.
 */
function Preview({ plan, fields }: { plan: Plan; fields: readonly ImportField[] }) {
  const shown = plan.rows.slice(0, PREVIEW_ROWS);
  const hidden = plan.rows.length - shown.length;

  const summary = (['new', 'changed', 'unchanged', 'blank', 'blocked'] as const)
    .filter((s) => plan.counts[s] > 0)
    .map((s) => `${plan.counts[s]} ${STATUS_LABEL[s].toLowerCase()}`)
    .join(' · ');

  return (
    <div className="mt">
      <p className="label">
        Preview{' '}
        {plan.dates.length > 0 && (
          <span className="muted sm">
            {formatDate(plan.dates[0])}
            {plan.dates.length > 1 && <> to {formatDate(plan.dates[plan.dates.length - 1])}</>} ·{' '}
            {plan.dates.length} day{plan.dates.length === 1 ? '' : 's'}
          </span>
        )}
      </p>
      <p className="muted sm">{summary}</p>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Date</th>
              <th>Campaign</th>
              {fields.map((f) => (
                <th key={f} className="right">
                  {REPORT_LABELS[f]}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.line} className={r.status === 'blocked' ? 'blockedrow' : undefined}>
                <td className="daycell">{r.line}</td>
                <td className="daycell">{r.date ? formatDate(r.date) : r.rawDate || '—'}</td>
                <td>{r.campaignName === '' ? UNATTRIBUTED : r.campaignName}</td>
                {fields.map((f) => {
                  const to = r.stated[f];
                  const change = r.changes.find((c) => c.field === f);
                  return (
                    <td key={f} className="right">
                      {to === undefined ? (
                        <span className="muted">—</span>
                      ) : change ? (
                        <>
                          <s className="muted">{figureText(f, change.from)}</s>{' '}
                          {figureText(f, to)}
                        </>
                      ) : (
                        figureText(f, to)
                      )}
                    </td>
                  );
                })}
                <td>
                  <span className={`pill ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  {r.problem && <div className="hint sm">{r.problem}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hidden > 0 && (
        <p className="muted sm">
          …and {hidden} more row{hidden === 1 ? '' : 's'}, counted above but not listed.
        </p>
      )}
    </div>
  );
}
