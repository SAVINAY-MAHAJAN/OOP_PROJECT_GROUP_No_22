import { useState } from 'react';
import { Pill } from './Brand.jsx';
import { api, encoded, patch, post, queryString, useJson } from './api.js';
import { capacityTone } from './employee.jsx';
import { priorityText, RiskPill, urgentColumns } from './incident-browser.jsx';
import { defaultRiskThreshold } from '../shared/constants.js';
import {
  Bars,
  ErrorText,
  Field,
  formData,
  levels,
  LoadStatus,
  Modal,
  optionsFor,
  Pager,
  priorityLabel,
  roleLabel,
  Stat,
  Table,
  useTask,
  when,
} from './ui.jsx';

const dashboardEvents = ['dashboard-changed'];
export function Dashboard({ active, onIncident }) {
  const query = useJson('/admin/dashboard', { active, poll: 10000, events: dashboardEvents });
  const task = useTask();
  const [log, setLog] = useState(null);
  const d = query.data;
  if (!d) return <LoadStatus {...query} />;
  const serviceMax = Math.max(1, ...d.byService.map((x) => x.value));
  const priorityMax = Math.max(1, ...d.byPriority.map((x) => x.value));
  return (
    <div className="stack">
      <div className="row between">
        <span className="summary">
          As of {when(d.now, true)}
          {d.clockOffsetMinutes > 0 && ' (simulated +' + d.clockOffsetMinutes + ' min)'}
        </span>
        <div className="row">
          <button className="secondary" onClick={query.refresh}>
            Refresh
          </button>
          <a className="button-link secondary" href="/api/admin/report.csv" download>
            Download CSV
          </a>
          <button
            disabled={task.pending}
            onClick={() =>
              task.run(async () => {
                setLog((await post('/admin/monitor')).log);
                query.refresh();
              })
            }
          >
            Run SLA / escalation check
          </button>
        </div>
      </div>
      <ErrorText error={query.error || task.error} />
      <div className="stats">
        <Stat
          label="TOTAL INCIDENTS"
          value={d.total}
          tone="blue"
          description={d.total - d.open + ' no longer open'}
        />
        <Stat label="OPEN" value={d.open} tone="purple" description="currently being handled" />
        <Stat
          label="CRITICAL (OPEN P1)"
          value={d.critical}
          tone="red"
          description="need immediate attention"
        />
        <Stat label="SLA VIOLATIONS" value={d.violations} tone="red" description="deadline missed" />
        <Stat label="AT SLA RISK" value={d.risk} tone="amber" description="approaching deadline" />
        <Stat
          label="PREDICTED TO BREACH"
          value={d.predictedToBreach ?? 0}
          tone="amber"
          description={(d.riskThresholdPercent ?? defaultRiskThreshold) + '% forecast threshold'}
        />
        <Stat
          label="USER FEEDBACK"
          value={d.averageFeedback == null ? '–' : d.averageFeedback.toFixed(1) + ' / 5'}
          tone="green"
          description={
            d.resolutionMinutes == null
              ? 'no resolved incidents yet'
              : 'avg resolution ' + Math.round(d.resolutionMinutes) + ' min'
          }
        />
      </div>
      {!!d.outages.length && (
        <div className="banner" role="status">
          <strong>Suspected outage</strong> ·{' '}
          {d.outages
            .map(
              (c) =>
                c.service +
                ' (' +
                c.incidents.join(', ') +
                (c.count > c.incidents.length
                  ? ' and ' + (c.count - c.incidents.length) + ' more'
                  : '') +
                ')',
            )
            .join(' | ')}
          <small> · 3+ open incidents within one hour</small>
        </div>
      )}
      <div className="charts">
        <Bars
          title="Technician workload (active / max)"
          rows={d.loads.map((t) => ({
            label: t.name + (t.available ? '' : ' (off)'),
            value: t.load,
            max: t.maxConcurrent,
            text: t.load + ' / ' + t.maxConcurrent,
            tone: capacityTone(t.load, t.maxConcurrent),
          }))}
        />
        <Bars
          title="Incidents by service"
          rows={d.byService.map((r) => ({ ...r, max: serviceMax, tone: 'teal' }))}
          scrollable
        />
        <Bars
          title="Incidents by priority"
          rows={d.byPriority.map((r, i) => ({
            label: priorityText(r.priority),
            value: r.value,
            max: priorityMax,
            tone: ['red', 'amber', 'blue', 'gray'][i],
          }))}
        />
      </div>
      <DailyVolume rows={d.volume || []} />
      <section className="card">
        <h2>Predicted resolution breaches</h2>
        <Table
          columns={[
            { key: 'id', title: 'ID' },
            { key: 'title', title: 'Title' },
            { key: 'serviceName', title: 'Service' },
            {
              key: 'priority',
              title: 'Priority',
              render: (row) => <Pill value={priorityText(row.priority)} />,
            },
            { key: 'technicianName', title: 'Technician' },
            { key: 'risk', title: 'Forecast', render: (row) => <RiskPill risk={row.slaRisk} /> },
          ]}
          rows={d.predictedQueue || []}
          label="Predicted resolution breaches"
          onSelect={onIncident}
          empty="No open incidents meet the prediction threshold."
        />
      </section>
      <section className="card">
        <h2>Most urgent open incidents (earliest resolution deadline)</h2>
        <Table
          columns={urgentColumns}
          rows={d.urgent}
          label="Urgent incidents"
          empty="No open incidents."
          onSelect={onIncident}
        />
      </section>
      {log && (
        <Modal title="SLA / escalation check" onClose={() => setLog(null)}>
          {log.length ? (
            <ul className="check-log">
              {log.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No new SLA warnings, violations or escalations.</p>
          )}
        </Modal>
      )}
    </div>
  );
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
function dailyLabel(date) {
  return dayFormat.format(new Date(date + 'T00:00:00Z'));
}

function DailyVolume({ rows }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="card">
      <h2>Incidents reported by day</h2>
      {rows.length === 0 ? (
        <p className="muted">No data yet.</p>
      ) : (
        <figure className="volume-chart">
          <ol className="volume-plot" aria-label="Daily incident totals">
            {rows.map(({ date, count }) => {
              const label =
                dailyLabel(date) + ' · ' + count + (count === 1 ? ' incident' : ' incidents');
              return (
                <li key={date} title={label}>
                  <span className="sr-only">{label}</span>
                  <span
                    className="volume-bar"
                    aria-hidden="true"
                    style={{ blockSize: Math.round((100 * count) / max) + '%' }}
                  />
                </li>
              );
            })}
          </ol>
          <figcaption className="small row between">
            <span>{dailyLabel(rows[0].date)}</span>
            <span>{dailyLabel(rows.at(-1).date)}</span>
          </figcaption>
        </figure>
      )}
    </section>
  );
}

const deliveryState = (row) => row.state || 'SIMULATED';
const outboxColumns = [
  { key: 'createdAt', title: 'Created', render: (row) => when(row.createdAt, true) },
  {
    key: 'channel',
    title: 'Channel',
    render: (row) => <Pill value={row.channel} tone={row.channel === 'EMAIL' ? 'blue' : 'purple'} />,
  },
  { key: 'state', title: 'Delivery state', render: (row) => <Pill value={deliveryState(row)} /> },
  {
    key: 'recipient',
    title: 'Recipient',
    render: (row) => row.to || row.recipientName || row.recipientId || '–',
  },
  { key: 'incidentId', title: 'Incident' },
  { key: 'subject', title: 'Subject' },
  { key: 'message', title: 'Message' },
];

export function Outbox({ active }) {
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState('');
  const query = useJson('/admin/outbox' + queryString({ page, channel }), {
    active,
    poll: 10000,
    events: dashboardEvents,
  });
  const { data, error } = query;
  return (
    <div className="stack">
      <div className="filters">
        <Field
          label="Notification channel"
          value={channel}
          options={[
            { value: '', label: 'All channels' },
            { value: 'EMAIL', label: 'Email' },
            { value: 'SMS', label: 'SMS' },
          ]}
          onChange={(event) => {
            setChannel(event.target.value);
            setPage(1);
          }}
        />
        <button className="secondary" onClick={query.refresh}>
          Refresh
        </button>
      </div>
      <LoadStatus data={data} error={error} />
      {data && (
        <>
          <Table
            columns={outboxColumns}
            rows={data.rows}
            label="Notification outbox"
            empty="No messages in this outbox."
          />
          <Pager {...data} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function UserForm({ record, onClose, onSubmit }) {
  const [type, setType] = useState(record?.role || 'EMPLOYEE');
  return (
    <Modal
      title={record ? 'Edit ' + record.name : 'Create user'}
      onClose={onClose}
      onSubmit={(data) =>
        onSubmit({
          ...data,
          role: type,
          teamLead: data.teamLead === 'on',
          available: record ? data.available === 'on' : true,
        })
      }
    >
      {!record && (
        <>
          <Field
            label="Role"
            name="role"
            options={Object.keys(roleLabel)}
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <Field label="Name" name="name" minLength={2} maxLength={60} required />
          <Field label="E-mail" name="email" maxLength={254} required />
          <Field
            label="Initial password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            required
          />
        </>
      )}
      {type === 'EMPLOYEE' && (
        <>
          <Field label="Employee: department" name="department" maxLength={120} />
          <Field label="Employee: location" name="location" maxLength={120} />
        </>
      )}
      {type === 'TECHNICIAN' && (
        <>
          <Field
            label="Skills (comma separated categories)"
            name="skills"
            defaultValue={record?.skills.join(', ')}
            maxLength={2000}
          />
          <Field
            label="Years of experience"
            name="experienceYears"
            type="number"
            min={0}
            max={80}
            defaultValue={record?.experienceYears ?? 1}
            required
          />
          <Field
            label="Max concurrent incidents"
            name="maxConcurrent"
            type="number"
            min={1}
            max={10000}
            defaultValue={record?.maxConcurrent ?? 5}
            required
          />
          <div className="row actions">
            <Field label="Team lead" name="teamLead" type="checkbox" defaultChecked={record?.teamLead} />
            {record && (
              <Field
                label="Available"
                name="available"
                type="checkbox"
                defaultChecked={record.available}
              />
            )}
          </div>
        </>
      )}
      {type === 'ADMINISTRATOR' && (
        <Field
          label="Admin: title (IT Manager / System Administrator)"
          name="title"
          defaultValue="IT Manager"
          maxLength={90}
        />
      )}
    </Modal>
  );
}

export function Users({ active }) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [dialog, setDialog] = useState(null);
  const query = useJson('/admin/users' + queryString({ page }), { active, poll: 10000 }),
    task = useTask();
  const rows = query.data?.rows || [],
    row = rows.find((u) => u.id === selected);
  async function save(record, data) {
    if (record) await patch('/admin/users/' + encoded(record.id), data);
    else await post('/admin/users', data);
    query.refresh();
  }
  return (
    <div className="stack">
      <div className="row">
        <button className="secondary" onClick={query.refresh}>
          Refresh
        </button>
        <button onClick={() => setDialog({ record: null })}>Add user</button>
        <button
          disabled={!row || task.pending}
          onClick={() => task.run(() => save(row, { active: !row.active }))}
        >
          Activate / deactivate
        </button>
        <button disabled={row?.role !== 'TECHNICIAN'} onClick={() => setDialog({ record: row })}>
          Edit technician
        </button>
      </div>
      <ErrorText error={task.error} />
      <LoadStatus {...query} />
      {query.data && (
        <>
          <Table
            label="Users"
            rows={rows}
            selected={selected}
            onSelect={setSelected}
            columns={[
              { key: 'id', title: 'ID' },
              { key: 'name', title: 'Name' },
              { key: 'email', title: 'E-mail' },
              { key: 'role', title: 'Role', render: (u) => roleLabel[u.role] },
              {
                key: 'active',
                title: 'Active',
                render: (u) => <Pill value={u.active ? 'yes' : 'NO'} />,
              },
              {
                key: 'details',
                title: 'Details',
                render: (u) =>
                  u.role === 'EMPLOYEE'
                    ? [u.department, u.location].filter(Boolean).join(' · ')
                    : u.role === 'TECHNICIAN'
                      ? u.skills.join(', ') +
                        ' · ' +
                        u.experienceYears +
                        ' yrs · max ' +
                        u.maxConcurrent +
                        (u.teamLead ? ' · Team Lead' : '') +
                        (u.available ? '' : ' · Unavailable')
                      : u.title,
              },
            ]}
          />
          <Pager
            {...query.data}
            onPage={(n) => {
              setPage(n);
              setSelected(null);
            }}
          />
        </>
      )}
      {dialog && (
        <UserForm
          record={dialog.record}
          onClose={() => setDialog(null)}
          onSubmit={(data) => save(dialog.record, data)}
        />
      )}
    </div>
  );
}

function ServiceFields({ record, data }) {
  return (
    <>
      <Field
        label="Name"
        name="name"
        defaultValue={record?.name}
        minLength={2}
        maxLength={60}
        required
      />
      <Field
        label="Description"
        name="description"
        defaultValue={record?.description}
        maxLength={2000}
      />
      <Field
        label="Business criticality"
        name="criticality"
        options={levels}
        defaultValue={record?.criticality || 'MEDIUM'}
      />
      <Field
        label="SLA policy"
        name="policy"
        options={[{ value: '', label: '(default policy)' }, ...optionsFor(data.policies)]}
        defaultValue={record?.policy || ''}
      />
      <Field
        label="Default category"
        name="defaultCategory"
        options={[{ value: '', label: '(none)' }, ...optionsFor(data.categories)]}
        defaultValue={record?.defaultCategory || ''}
      />
    </>
  );
}
function PolicyFields({ record }) {
  return (
    <>
      <Field
        label="Policy name"
        name="name"
        defaultValue={record?.name}
        minLength={2}
        maxLength={40}
        required
      />
      {Object.keys(priorityLabel).map((p) => (
        <div className="columns policy-target" key={p}>
          <Field
            label={p + ' response (minutes)'}
            name={p + 'r'}
            type="number"
            min={1}
            max={525600}
            defaultValue={record?.targets[p].responseMinutes}
            required
          />
          <Field
            label={p + ' resolution (minutes)'}
            name={p + 's'}
            type="number"
            min={1}
            max={525600}
            defaultValue={record?.targets[p].resolutionMinutes}
            required
          />
        </div>
      ))}
    </>
  );
}
function CategoryFields({ record }) {
  return (
    <>
      <Field
        label="Name"
        name="name"
        defaultValue={record?.name}
        minLength={2}
        maxLength={40}
        readOnly={Boolean(record)}
        required
      />
      <Field
        label="Description"
        name="description"
        defaultValue={record?.description}
        maxLength={2000}
      />
      <Field
        label="Keywords (comma separated)"
        name="keywords"
        defaultValue={record?.keywords.join(', ')}
        maxLength={2000}
        rows={4}
      />
    </>
  );
}
const catalogOptions = {
  services: { name: 'service', Fields: ServiceFields, deletable: true },
  policies: { name: 'policy', Fields: PolicyFields, deletable: false },
  categories: { name: 'category', Fields: CategoryFields, deletable: true },
};
const catalogColumns = {
  services: (data) => [
    { key: 'id', title: 'ID' },
    { key: 'name', title: 'Name' },
    { key: 'criticality', title: 'Criticality' },
    {
      key: 'policy',
      title: 'SLA policy',
      render: (s) => data.policies.find((p) => p.id === s.policy)?.name || '(default)',
    },
    { key: 'defaultCategory', title: 'Default category' },
    { key: 'description', title: 'Description' },
  ],
  policies: (data) => [
    { key: 'id', title: 'ID' },
    {
      key: 'name',
      title: 'Name',
      render: (p) => p.name + (p.id === data.defaultPolicyId ? ' (default)' : ''),
    },
    ...Object.keys(priorityLabel).map((p) => ({
      key: p,
      title: p + ' response/resolution (min)',
      render: (row) => row.targets[p].responseMinutes + ' / ' + row.targets[p].resolutionMinutes,
    })),
  ],
  categories: () => [
    { key: 'name', title: 'Name' },
    { key: 'description', title: 'Description' },
    {
      key: 'keywords',
      title: 'Keywords (used for auto-categorisation)',
      render: (c) => c.keywords.join(', '),
    },
  ],
};

export function CatalogEditor({ resource, active }) {
  const query = useJson('/catalog', { active }),
    task = useTask();
  const [selected, setSelected] = useState(null),
    [dialog, setDialog] = useState(null);
  if (!query.data) return <LoadStatus {...query} />;
  const data = query.data,
    rows = data[resource];
  const { name, Fields, deletable } = catalogOptions[resource];
  const row = rows.find((r) => r.id === selected);
  const endpoint = '/admin/' + resource;

  async function save(record, fields) {
    const body =
      resource === 'policies'
        ? {
            name: fields.name,
            targets: Object.fromEntries(
              Object.keys(priorityLabel).map((p) => [
                p,
                { responseMinutes: fields[p + 'r'], resolutionMinutes: fields[p + 's'] },
              ]),
            ),
          }
        : fields;
    if (record) await patch(endpoint + '/' + encoded(record.id), body);
    else await post(endpoint, body);
    query.refresh();
  }
  return (
    <div className="stack">
      <ErrorText error={query.error || task.error} />
      <div className="row">
        <button className="secondary" onClick={query.refresh}>
          Refresh
        </button>
        <button onClick={() => setDialog({ kind: 'edit', record: null })}>Add {name}</button>
        <button disabled={!row} onClick={() => setDialog({ kind: 'edit', record: row })}>
          Edit {name}
        </button>
        {deletable ? (
          <button disabled={!row} onClick={() => setDialog({ kind: 'delete', record: row })}>
            Delete {name}
          </button>
        ) : (
          <button
            disabled={!row || task.pending || row.id === data.defaultPolicyId}
            onClick={() =>
              task.run(async () => {
                await post(endpoint + '/' + encoded(row.id) + '/default');
                query.refresh();
              })
            }
          >
            Set as default
          </button>
        )}
      </div>
      <Table
        label={resource}
        rows={rows}
        columns={catalogColumns[resource](data)}
        selected={selected}
        onSelect={setSelected}
      />
      {dialog?.kind === 'edit' && (
        <Modal
          title={dialog.record ? 'Edit ' + dialog.record.name : 'New ' + name}
          onClose={() => setDialog(null)}
          onSubmit={(fields) => save(dialog.record, fields)}
        >
          <Fields record={dialog.record} data={data} />
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          title={'Delete ' + dialog.record.name}
          submitLabel="Delete"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await api(endpoint + '/' + encoded(dialog.record.id), { method: 'DELETE' });
            setSelected(null);
            query.refresh();
          }}
        >
          <p>Delete this {name}?</p>
        </Modal>
      )}
    </div>
  );
}

export function Violations({ active, onIncident }) {
  const [page, setPage] = useState(1);
  const query = useJson('/admin/violations' + queryString({ page }), {
    active,
    poll: 10000,
    events: dashboardEvents,
  });
  return (
    <div className="stack">
      <div>
        <button className="secondary" onClick={query.refresh}>
          Refresh
        </button>
      </div>
      <LoadStatus {...query} />
      {query.data && (
        <>
          <Table
            label="SLA violations"
            rows={query.data.rows}
            rowKey={(r) => r.id + '-' + r.finding}
            onSelect={onIncident}
            columns={[
              { key: 'at', title: 'Detected', render: (r) => when(r.at, true) },
              {
                key: 'type',
                title: 'Type',
                render: (r) => (
                  <Pill value={r.finding.endsWith('VIOLATION') ? 'VIOLATION' : 'warning'} />
                ),
              },
              { key: 'finding', title: 'Finding' },
              { key: 'id', title: 'Incident' },
              { key: 'priority', title: 'Priority', render: (r) => <Pill value={r.priority} /> },
              { key: 'serviceName', title: 'Service' },
              { key: 'technicianName', title: 'Technician' },
              { key: 'status', title: 'Status', render: (r) => <Pill value={r.status} /> },
            ]}
          />
          <Pager {...query.data} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export function AuditLog({ active }) {
  const [page, setPage] = useState(1),
    [id, setId] = useState('');
  const query = useJson('/admin/audit' + queryString({ page, id }), {
    active,
    poll: 10000,
    events: dashboardEvents,
  });
  return (
    <div className="stack">
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setId(formData(e).id);
          setPage(1);
        }}
      >
        <Field label="Incident ID (blank = all)" name="id" maxLength={80} />
        <button type="submit">Filter</button>
        <button type="button" className="secondary" onClick={query.refresh}>
          Refresh
        </button>
      </form>
      <LoadStatus {...query} />
      {query.data && (
        <>
          <Table
            label="Audit log"
            rows={query.data.rows}
            columns={[
              { key: 'timestamp', title: 'Time', render: (r) => when(r.timestamp, true) },
              { key: 'actor', title: 'User' },
              { key: 'action', title: 'Action' },
              { key: 'incidentId', title: 'Incident' },
              {
                key: 'previousState',
                title: 'Previous',
                render: (r) => (r.previousState ? <Pill value={r.previousState} /> : '–'),
              },
              {
                key: 'newState',
                title: 'New',
                render: (r) => (r.newState ? <Pill value={r.newState} /> : '–'),
              },
              { key: 'description', title: 'Description' },
            ]}
          />
          <Pager {...query.data} onPage={setPage} />
        </>
      )}
    </div>
  );
}

const assignOptions = [
  {
    value: 'SKILL',
    label: 'SKILL - Skill-based: category skill, free capacity, experience and service history',
  },
  { value: 'LOAD', label: 'LOAD - Load-based: technician with the fewest active incidents' },
  { value: 'ROUND_ROBIN', label: 'ROUND_ROBIN - Technicians take turns in ID order' },
  { value: 'EXPERIENCE', label: 'EXPERIENCE - Seniors for P1–P2, juniors for P3–P4' },
];
const priorityOptions = [
  { value: 'WEIGHTED', label: 'WEIGHTED - Weighted impact × urgency × criticality × affected users' },
  { value: 'RULES', label: 'RULES - Ordered business rules, first match wins' },
];
export function Settings({ active, demo }) {
  const query = useJson('/admin/settings', { active, poll: 10000 }),
    task = useTask();
  const [saved, setSaved] = useState(false);
  if (!query.data) return <LoadStatus {...query} />;
  const d = query.data;
  return (
    <section className="card settings-card stack">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const data = formData(e);
          setSaved(false);
          task.run(async () => {
            await patch('/admin/settings', data);
            query.refresh();
            setSaved(true);
          });
        }}
      >
        <Field
          label="Assignment strategy"
          name="assignmentStrategyKey"
          options={assignOptions}
          defaultValue={d.assignmentStrategyKey}
        />
        <Field
          label="Priority strategy"
          name="priorityStrategyKey"
          options={priorityOptions}
          defaultValue={d.priorityStrategyKey}
        />
        <Field
          label="Escalation step (minutes)"
          name="escalationStepMinutes"
          type="number"
          min={1}
          max={1440}
          defaultValue={d.escalationStepMinutes}
          required
        />
        <Field
          label="SLA warning at (%)"
          name="warnPercent"
          type="number"
          min={10}
          max={99}
          defaultValue={Math.round(d.slaWarningFraction * 100)}
          required
        />
        <Field
          label="Predicted breach alert at (%)"
          name="riskThresholdPercent"
          type="number"
          min={10}
          max={99}
          defaultValue={d.riskThresholdPercent ?? defaultRiskThreshold}
          required
        />
        <div className="field-note">
          <button type="submit" disabled={task.pending}>
            Save settings
          </button>
        </div>
      </form>
      <ErrorText error={query.error || task.error} />
      {saved && (
        <p className="success" role="status">
          Settings saved. New incidents use the selected strategies immediately.
        </p>
      )}
      {demo && (
        <>
          <hr />
          <p>Fast-forward the demo clock to see SLA warnings, violations and escalations.</p>
          <div className="row">
            {[5, 15, 60, 0].map((minutes) => (
              <button
                key={minutes}
                className={minutes ? 'primary' : 'secondary'}
                disabled={task.pending}
                onClick={() =>
                  task.run(async () => {
                    await post('/admin/clock', minutes ? { minutes } : { reset: true });
                    query.refresh();
                  })
                }
              >
                {minutes ? '+' + minutes + ' min' : 'Reset clock'}
              </button>
            ))}
          </div>
          <p className="summary">
            Application time {when(d.now, true)} &nbsp; (offset {d.clockOffsetMinutes} min)
          </p>
        </>
      )}
    </section>
  );
}
