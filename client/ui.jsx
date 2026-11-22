import { useEffect, useId, useRef, useState } from 'react';
import { defaultTimeZone, openStates } from '../shared/constants.js';

export { roleLabel, priorityLabel, levels, states as statuses } from '../shared/constants.js';
export const isOpen = (status) => openStates.includes(status);

let dateFormats;
export function configureTimeZone(timeZone) {
  const common = {
    timeZone,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  dateFormats = {
    compact: new Intl.DateTimeFormat('en-GB', common),
    full: new Intl.DateTimeFormat('en-GB', { ...common, year: 'numeric', second: '2-digit' }),
  };
}
configureTimeZone(defaultTimeZone);

export function when(date, full = false) {
  return date ? dateFormats[full ? 'full' : 'compact'].format(new Date(date)).replace(',', '') : '–';
}

export function Field({ label, options, rows, type = 'text', ...props }) {
  const id = useId();
  if (type === 'checkbox')
    return (
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" {...props} />
        {label}
      </label>
    );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {options ? (
        <select id={id} {...props}>
          {options.map((option) =>
            typeof option === 'string' ? (
              <option key={option}>{option}</option>
            ) : (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </select>
      ) : rows ? (
        <textarea id={id} rows={rows} {...props} />
      ) : (
        <input id={id} type={type} {...props} />
      )}
    </div>
  );
}
export const optionsFor = (rows) => rows.map((row) => ({ value: row.id, label: row.name }));
export const formData = (event) => Object.fromEntries(new FormData(event.currentTarget));

export function ErrorText({ error }) {
  return error ? (
    <p className="error" role="alert">
      {error.message || error}
    </p>
  ) : null;
}
export function LoadStatus({ data, error }) {
  return (
    <>
      <ErrorText error={error} />
      {!data && !error && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
    </>
  );
}
export function useTask() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  async function run(action) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return { pending, error, setError, run };
}

export function Modal({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel = 'OK',
  closeLabel = 'Cancel',
}) {
  const ref = useRef(null);
  const titleId = useId();
  const { pending, error, run } = useTask();
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {onSubmit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = formData(event);
            run(async () => {
              await onSubmit(data);
              onClose();
            });
          }}
        >
          {children}
          <ErrorText error={error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={pending}>
              {closeLabel}
            </button>
            <button type="submit" disabled={pending}>
              {pending ? 'Working…' : submitLabel}
            </button>
          </div>
        </form>
      ) : (
        <>
          {children}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {submitLabel}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

export function Table({
  columns,
  rows = [],
  selected,
  onSelect,
  empty = 'No records found.',
  sort,
  onSort,
  label = 'Records',
  rowKey = (row) => row.id,
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table>
        <thead>
          <tr>
            {columns.map((col) => {
              const ariaSort =
                sort?.key === col.key
                  ? sort.direction === 'desc'
                    ? 'descending'
                    : 'ascending'
                  : undefined;
              return (
                <th key={col.key} scope="col" aria-sort={ariaSort}>
                  {onSort && col.sort !== false ? (
                    <button type="button" onClick={() => onSort(col.key)}>
                      {col.title}
                      {ariaSort ? (ariaSort === 'ascending' ? ' ↑' : ' ↓') : ''}
                    </button>
                  ) : (
                    col.title
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                aria-selected={onSelect ? selected === row.id : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onClick={onSelect ? () => onSelect(row.id) : undefined}
                onKeyDown={
                  onSelect
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(row.id);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td key={col.key}>{col.render ? col.render(row) : (row[col.key] ?? '–')}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="muted" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, size, total, onPage }) {
  const pages = Math.ceil(total / size);
  if (pages <= 1 && page <= 1) return null;
  return (
    <nav className="row pager" aria-label="Page controls">
      <button className="secondary" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span className="small">
        Page {page} of {Math.max(pages, 1)}
      </span>
      <button className="secondary" onClick={() => onPage(page + 1)} disabled={page >= pages}>
        Next
      </button>
    </nav>
  );
}

export function Stat({ label, value, description, tone }) {
  return (
    <article className="stat" data-tone={tone}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{description}</span>
    </article>
  );
}
export function Bars({ title, rows, scrollable = false }) {
  const bars = rows.map((row) => (
    <div className="bar-row" data-tone={row.tone} key={row.label}>
      <span title={row.label}>{row.label}</span>
      <progress value={row.value} max={row.max || 1} aria-label={row.label} />
      <small>{row.text ?? row.value}</small>
    </div>
  ));
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">No data yet.</p>
      ) : scrollable ? (
        <div className="bars-scroll" role="region" aria-label={title} tabIndex={0}>
          {bars}
        </div>
      ) : (
        bars
      )}
    </section>
  );
}
export function Facts({ rows }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div className="fact" key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}
