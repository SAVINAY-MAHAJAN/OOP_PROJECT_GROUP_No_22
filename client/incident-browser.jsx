import { useCallback, useEffect, useState } from 'react';
import { escalationChain, slaStates } from '../shared/constants.js';
import { Pill } from './Brand.jsx';
import { api, encoded, post, queryString, useJson } from './api.js';
import {
  ErrorText,
  Facts,
  Field,
  formData,
  isOpen,
  LoadStatus,
  Modal,
  optionsFor,
  Pager,
  priorityLabel,
  statuses,
  Table,
  useTask,
  when,
} from './ui.jsx';

const incidentEvents = ['incident-changed', 'workload-changed'];
export const priorityText = (p) => (p ? p + ' ' + priorityLabel[p] : '–');
const riskTones = { HIGH: 'red', MEDIUM: 'amber', LOW: 'green' };
export function RiskPill({ risk }) {
  return (
    <Pill tone={riskTones[risk.level]}>
      {Math.round(risk.probability * 100)}% · {risk.level}
    </Pill>
  );
}
const stateCell = (key) => (row) => (row[key] ? <Pill value={row[key]} /> : '–');
export const urgentColumns = [
  { key: 'id', title: 'ID' },
  { key: 'title', title: 'Title' },
  { key: 'service', title: 'Service', render: (i) => i.serviceName },
  { key: 'priority', title: 'Priority', render: (i) => <Pill value={priorityText(i.priority)} /> },
  { key: 'status', title: 'Status', render: stateCell('status') },
  { key: 'slaStatus', title: 'SLA', render: stateCell('slaStatus') },
  { key: 'due', title: 'Resolution due', render: (i) => when(i.sla?.resolutionDue) },
  { key: 'assignedTo', title: 'Technician', render: (i) => i.technicianName || '–' },
];
const tableColumns = [
  ...urgentColumns.slice(0, 3),
  { key: 'category', title: 'Category' },
  urgentColumns[3],
  urgentColumns[4],
  urgentColumns[7],
  urgentColumns[5],
  { key: 'createdAt', title: 'Created', render: (i) => when(i.createdAt) },
];
const all = { value: '', label: '(any)' };

function Filters({ active, admin, onSearch }) {
  const { data, error } = useJson('/catalog', { active });
  return (
    <section className="card">
      <h2>Search and filter</h2>
      <ErrorText error={error} />
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(formData(e));
        }}
        onReset={() => onSearch({})}
      >
        <Field label="ID" name="id" maxLength={80} />
        <Field label="Keyword" name="text" maxLength={160} />
        <Field label="Status" name="status" options={[all, ...statuses]} />
        <Field label="Priority" name="priority" options={[all, ...Object.keys(priorityLabel)]} />
        <Field label="Category" name="category" options={[all, ...optionsFor(data?.categories || [])]} />
        <Field label="Service" name="service" options={[all, ...optionsFor(data?.services || [])]} />
        {admin && (
          <Field
            label="Technician"
            name="assignedTo"
            options={[all, ...optionsFor(data?.technicians || [])]}
          />
        )}
        <Field label="SLA" name="sla" options={[all, ...slaStates]} />
        <Field label="From" name="from" type="date" />
        <Field label="To" name="to" type="date" />
        <div className="row">
          <button type="submit">Search</button>
          <button type="reset" className="secondary">
            Clear
          </button>
        </div>
      </form>
    </section>
  );
}

function IncidentDetail({ data: i, error, id }) {
  if (!id)
    return (
      <section className="detail">
        <p className="muted">
          Select an incident above to see its full details, SLA, notes and history.
        </p>
      </section>
    );
  if (!i)
    return (
      <section className="detail">
        <LoadStatus data={i} error={error} />
      </section>
    );
  return (
    <section className="detail" tabIndex={0} aria-label={'Incident ' + i.id + ' details'}>
      <h2>
        {i.id} &nbsp; {i.title}
      </h2>
      <div className="row">
        <Pill value={priorityText(i.priority)} />
        <Pill value={i.status} />
        <Pill value={i.slaStatus} />
        {i.sla?.pausedAt && i.slaStatus !== 'PAUSED' && <Pill value="PAUSED" tone="amber" />}
        {i.escalationLevel > 0 && <Pill value={'ESCALATED: ' + escalationChain[i.escalationLevel]} />}
      </div>
      <Facts
        rows={[
          ['Reporter', i.reporterName + ' (' + i.reporter + ')'],
          ['Service', i.serviceName + ' (criticality ' + i.businessCriticality + ')'],
          ['Category', i.category],
          [
            'Impact / Urgency',
            i.impact +
              ' / ' +
              i.urgency +
              ' · ' +
              i.affectedUsers +
              (i.affectedUsers === 1 ? ' user affected' : ' users affected'),
          ],
          [
            'Assigned to',
            i.technicianName ? i.technicianName + ' (' + i.assignedTo + ')' : 'unassigned',
          ],
          ['Created', when(i.createdAt) + ' · last update ' + when(i.updatedAt)],
          ...(i.relatedCount || i.relatedIds.length
            ? [
                [
                  'Possibly related',
                  i.relatedIds.length
                    ? i.relatedIds.join(', ') +
                      (i.relatedCount > i.relatedIds.length ? ' and other reports' : '')
                    : i.relatedCount + ' reports',
                ],
              ]
            : []),
        ]}
      />
      {i.sla && (
        <>
          <h3>SLA – {i.sla.policyName}</h3>
          <Facts
            rows={[
              [
                'Response',
                <>
                  due {when(i.sla.responseDue)} · acknowledged {when(i.sla.respondedAt)}{' '}
                  {i.sla.responseBreached && <Pill value="VIOLATED" />}
                </>,
              ],
              [
                'Resolution',
                i.sla.pausedAt ? (
                  <>
                    waiting for the reporter · paused {when(i.sla.pausedAt)}{' '}
                    {i.sla.resolutionBreached && <Pill value="VIOLATED" />}
                  </>
                ) : (
                  <>
                    due {when(i.sla.resolutionDue)} · resolved {when(i.sla.resolvedAt)}{' '}
                    {i.sla.resolutionBreached && <Pill value="VIOLATED" />}
                  </>
                ),
              ],
            ]}
          />
        </>
      )}
      {i.slaRisk && (
        <section className="sla-forecast">
          <h3>Predicted resolution breach</h3>
          <RiskPill risk={i.slaRisk} />
          <ul>
            {i.slaRisk.factors.map((factor) => (
              <li key={factor}>{factor}</li>
            ))}
          </ul>
        </section>
      )}
      <h3>Description</h3>
      <p>{i.description}</p>
      {i.notes.length > 0 && (
        <>
          <h3>Conversation and notes</h3>
          <ul className="history">
            {i.notes.map((n, index) => (
              <li key={index}>
                <small>{when(n.at)}</small>
                <div>
                  <strong>{n.author}</strong> <small>{n.kind.toLowerCase().replaceAll('_', ' ')}</small>
                  <p>{n.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {i.resolution && (
        <>
          <h3>Resolution</h3>
          <p>
            {i.resolution}
            <br />
            <small>
              by {i.resolvedBy} at {when(i.resolvedAt)}
            </small>
          </p>
        </>
      )}
      {i.feedback && (
        <>
          <h3>Feedback</h3>
          <p>
            {i.feedback.rating} / 5 &nbsp; {i.feedback.comment}
          </p>
        </>
      )}
      {i.closedAt && (
        <>
          <h3>Closure</h3>
          <p>
            {i.closureNote}
            <br />
            <small>
              {i.closedBy}, {when(i.closedAt)}
            </small>
          </p>
        </>
      )}
      {i.cancelledAt && (
        <>
          <h3>Cancellation</h3>
          <p>
            {i.cancelReason}
            <br />
            <small>
              {i.cancelledBy}, {when(i.cancelledAt)}
            </small>
          </p>
        </>
      )}
      {i.history.length > 0 && (
        <>
          <h3>History (audit trail)</h3>
          <ul className="history">
            {i.history.map((a) => (
              <li key={a.id}>
                <small>{when(a.timestamp)}</small>
                <div>
                  <strong>{a.action}</strong>
                  <p>{a.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <ErrorText error={error} />
    </section>
  );
}

const employeeActions = [
  { id: 'reply', label: 'Add information / reply', enabled: (i) => isOpen(i.status) },
  { id: 'verify', label: 'Verify resolution & feedback', enabled: (i) => i.status === 'RESOLVED' },
  { id: 'cancel', label: 'Cancel incident', enabled: (i) => isOpen(i.status), secondary: true },
];
const technicianActions = [
  { id: 'acknowledge', label: 'Acknowledge', enabled: (i) => i.status === 'ASSIGNED', direct: true },
  {
    id: 'investigate',
    label: 'Start investigation',
    enabled: (i) => ['ACKNOWLEDGED', 'PENDING_INFO'].includes(i.status),
    direct: true,
  },
  { id: 'note', label: 'Add note', enabled: (i) => isOpen(i.status) },
  { id: 'request-info', label: 'Request info', enabled: (i) => i.status === 'IN_PROGRESS' },
  { id: 'suggest', label: 'Suggest resolution', enabled: () => true },
  { id: 'resolve', label: 'Resolve', enabled: (i) => i.status === 'IN_PROGRESS' },
  { id: 'close', label: 'Close', enabled: (i) => i.status === 'VERIFIED' },
  {
    id: 'decline',
    label: 'Decline assignment',
    enabled: (i) => i.status === 'ASSIGNED',
    secondary: true,
  },
];
const adminActions = [
  {
    id: 'assign',
    label: 'Assign / reassign…',
    enabled: (i) => ['CLASSIFIED', 'ASSIGNED'].includes(i.status),
  },
  { id: 'priority', label: 'Override priority', enabled: (i) => isOpen(i.status) },
  { id: 'close', label: 'Close incident', enabled: (i) => i.status === 'VERIFIED' },
  {
    id: 'unassign',
    label: 'Unassign technician',
    enabled: (i) => isOpen(i.status) && Boolean(i.assignedTo),
    secondary: true,
  },
];
const multiInput = {
  reply: ['Add information to', 'Details', 3, 2000],
  note: ['Investigation note for', 'Note', 3, 2000],
  'request-info': ['Ask the reporter for', 'Question', 5, 1000],
  resolve: ['Resolve', 'Resolution details', 10, 2000],
  cancel: ['Cancel', 'Reason for cancellation', 3, 2000],
  decline: ['Decline assignment for', 'Reason for declining', 3, 2000],
  unassign: ['Unassign technician from', 'Reason for unassigning', 3, 2000],
};
const confirmation = {
  cancel: 'Cancel incident',
  decline: 'Decline assignment',
  unassign: 'Unassign technician',
};

function Suggestions({ incident, onClose }) {
  const query = useJson('/incidents/' + encoded(incident.id) + '/resolutions');
  return (
    <Modal title={'Suggested resolutions for ' + incident.id} onClose={onClose}>
      <LoadStatus {...query} />
      {query.data?.length === 0 && <p>No similar resolved incidents were found.</p>}
      <div className="stack">
        {query.data?.map((r) => (
          <section className="card" key={r.id}>
            <strong>
              {r.id} · {r.title}
            </strong>{' '}
            <small>{Math.round(r.score * 100)}% similarity</small>
            <p className="preserve">{r.resolution}</p>
          </section>
        ))}
      </div>
    </Modal>
  );
}
function Assignment({ incident, onClose, onSubmit }) {
  const query = useJson('/incidents/' + encoded(incident.id) + '/recommendations');
  const ranking = query.data?.ranking;
  if (!ranking?.length)
    return (
      <Modal title={'Assign ' + incident.id} onClose={onClose}>
        <LoadStatus {...query} />
        {ranking && <p className="muted">{query.data.reason}</p>}
      </Modal>
    );
  return (
    <Modal title={'Assign ' + incident.id} onClose={onClose} onSubmit={onSubmit}>
      <div className="stack">
        <strong>Recommendation</strong>
        <p className="small">Strategy: {query.data.strategy}</p>
        <ol className="recommendations">
          {ranking.map((t) => (
            <li key={t.id}>
              <b>{t.name}</b>{' '}
              <small>
                {t.reason} · {t.score.toFixed(1)}
              </small>
            </li>
          ))}
        </ol>
        <Field
          label="Assign to"
          name="technician"
          options={[{ value: '', label: '(auto-pick best)' }, ...optionsFor(ranking)]}
        />
      </div>
    </Modal>
  );
}
function IncidentAction({ action, incident, onClose, onSubmit }) {
  if (action === 'suggest') return <Suggestions incident={incident} onClose={onClose} />;
  if (action === 'assign')
    return <Assignment incident={incident} onClose={onClose} onSubmit={onSubmit} />;
  if (action === 'verify')
    return (
      <Modal
        title={'Resolution of ' + incident.id}
        onClose={onClose}
        onSubmit={(data) => onSubmit({ ...data, accepted: data.decision === 'yes' })}
      >
        <p className="preserve">{incident.resolution}</p>
        <Field
          label="Is the problem solved?"
          name="decision"
          options={[
            { value: 'yes', label: 'Yes - accept resolution' },
            { value: 'no', label: 'No - reopen incident' },
          ]}
        />
        <Field label="Rating (1-5)" name="rating" options={['5', '4', '3', '2', '1']} />
        <Field label="Comment / reason" name="comment" rows={4} maxLength={2000} />
      </Modal>
    );
  if (action === 'priority')
    return (
      <Modal title={'Override priority of ' + incident.id} onClose={onClose} onSubmit={onSubmit}>
        <Field
          label="New priority"
          name="priority"
          options={Object.keys(priorityLabel)}
          defaultValue={incident.priority}
        />
      </Modal>
    );
  if (action === 'close')
    return (
      <Modal title={'Close ' + incident.id} onClose={onClose} onSubmit={onSubmit}>
        <Field label="Closure note" name="text" maxLength={2000} />
      </Modal>
    );
  const [title, label, min, max] = multiInput[action];
  const confirm = confirmation[action];
  return (
    <Modal
      title={title + ' ' + incident.id}
      onClose={onClose}
      onSubmit={onSubmit}
      submitLabel={confirm || 'OK'}
      closeLabel={confirm ? 'Go back' : 'Cancel'}
    >
      <Field label={label} name="text" minLength={min} maxLength={max} rows={5} required />
    </Modal>
  );
}

export function IncidentBrowser({ user, active, selected, onSelect }) {
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const task = useTask();
  const admin = user.role === 'ADMINISTRATOR';
  const actions = admin
    ? adminActions
    : user.role === 'TECHNICIAN'
      ? technicianActions
      : employeeActions;
  const detailEvent = useCallback(
    (event) =>
      event.type === 'workload-changed' ||
      (event.type === 'incident-changed' && event.incidentId === selected),
    [selected],
  );
  const list = useJson(
    '/incidents' +
      queryString({
        ...filters,
        page,
        queue: user.role === 'TECHNICIAN' ? 'assigned' : null,
        sort: sort?.key,
        dir: sort?.direction,
      }),
    { active, poll: 10000, events: incidentEvents },
  );
  const detail = useJson(selected ? '/incidents/' + encoded(selected) : null, {
    active,
    poll: 10000,
    events: detailEvent,
  });
  const summary = list.data?.summary;
  useEffect(() => {
    if (!active) setDialog(null);
  }, [active]);

  async function update(action, i, input) {
    try {
      await post('/incidents/' + encoded(i.id) + '/actions/' + action, {
        ...input,
        version: i.version || 0,
      });
      if (action === 'decline' && i.reporter !== user.id) onSelect(null, true);
    } finally {
      list.refresh();
      detail.refresh();
    }
  }
  return (
    <div className="stack incident-browser">
      <Filters
        active={active}
        admin={admin}
        onSearch={(fields) => {
          setFilters(fields);
          setPage(1);
          onSelect(null, true);
        }}
      />
      <div className="row">
        <button
          className="secondary"
          onClick={() => {
            list.refresh();
            detail.refresh();
          }}
        >
          Refresh
        </button>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.secondary ? 'secondary' : undefined}
            disabled={!detail.data || !action.enabled(detail.data) || task.pending}
            onClick={() =>
              action.direct
                ? task.run(() => update(action.id, detail.data, {}))
                : setDialog({ action: action.id, incident: detail.data })
            }
          >
            {action.label}
          </button>
        ))}
      </div>
      <ErrorText error={task.error} />
      {summary && (
        <p className="summary">
          {summary.total} incidents &nbsp;|&nbsp; {summary.open} open &nbsp;|&nbsp; {summary.breached}{' '}
          with SLA breached
        </p>
      )}
      <div className="split">
        <Table
          columns={tableColumns}
          rows={list.data?.rows}
          empty={list.error?.message || (list.data ? 'No incidents found.' : 'Loading…')}
          label="Incident list"
          selected={selected}
          onSelect={(id) => {
            onSelect(id);
            task.setError(null);
          }}
          sort={sort}
          onSort={(key) => {
            setSort({ key, direction: sort?.key === key && sort.direction === 'asc' ? 'desc' : 'asc' });
            setPage(1);
          }}
        />
        <IncidentDetail key={selected || 'none'} id={selected} data={detail.data} error={detail.error} />
      </div>
      {summary && (
        <Pager
          page={page}
          size={list.data.size}
          total={summary.total}
          onPage={(n) => {
            setPage(n);
            onSelect(null, true);
          }}
        />
      )}
      {dialog && (
        <IncidentAction
          {...dialog}
          onClose={() => setDialog(null)}
          onSubmit={(body) => update(dialog.action, dialog.incident, body)}
        />
      )}
    </div>
  );
}
