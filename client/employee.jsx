import { useState } from 'react';
import { Pill } from './Brand.jsx';
import { api, post, patch, queryString, useJson } from './api.js';
import {
  Bars,
  ErrorText,
  Field,
  levels,
  LoadStatus,
  Modal,
  optionsFor,
  Pager,
  Stat,
  Table,
  useTask,
  when,
} from './ui.jsx';

const emptyReport = {
  title: '',
  description: '',
  service: '',
  category: '',
  impact: 'MEDIUM',
  urgency: 'MEDIUM',
  affectedUsers: 1,
};
export function ReportIncident({ active, onReported }) {
  const catalog = useJson('/catalog', { active });
  const [input, setInput] = useState(emptyReport);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [duplicate, setDuplicate] = useState(null);
  const [created, setCreated] = useState(null);
  const task = useTask();
  const service =
    catalog.data?.services.find((s) => s.id === input.service) || catalog.data?.services[0];
  const form = { ...input, service: service?.id, requestId };
  const change = (key) => (event) => {
    setInput((old) => ({ ...old, [key]: event.target.value }));
    if (task.error) task.setError(null);
  };

  async function submit(force = false) {
    try {
      const { id } = await post('/incidents', { ...form, force });
      setCreated(await api('/incidents/' + id));
      setInput((old) => ({
        ...emptyReport,
        service: old.service,
        impact: old.impact,
        urgency: old.urgency,
      }));
      setRequestId(crypto.randomUUID());
    } catch (err) {
      if (err.code === 'DUPLICATE' && !force) setDuplicate(err.candidates);
      else throw err;
    }
  }

  return (
    <section className="card report-card">
      <h2>Describe the problem</h2>
      <p className="muted">
        The system will classify it, calculate the priority, apply the SLA and assign a technician
        automatically.
      </p>
      <LoadStatus {...catalog} />
      {catalog.data && (
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            task.run(() => submit());
          }}
        >
          <Field
            label="Title"
            value={input.title}
            onChange={change('title')}
            minLength={5}
            maxLength={120}
            required
          />
          <Field
            label="Description"
            value={input.description}
            onChange={change('description')}
            rows={6}
            minLength={10}
            maxLength={2000}
            required
          />
          <Field
            label="Affected service"
            options={optionsFor(catalog.data.services)}
            value={service?.id || ''}
            onChange={change('service')}
            required
          />
          {service && (
            <p className="field-note small">
              Business criticality of this service: {service.criticality} (used in the priority
              calculation)
            </p>
          )}
          <Field
            label="Category"
            options={[
              { value: '', label: '(auto-detect from description)' },
              ...optionsFor(catalog.data.categories),
            ]}
            value={input.category}
            onChange={change('category')}
          />
          <Field
            label="Impact (how bad?)"
            options={levels}
            value={input.impact}
            onChange={change('impact')}
          />
          <Field
            label="Urgency (how soon?)"
            options={levels}
            value={input.urgency}
            onChange={change('urgency')}
          />
          <Field
            label="Users affected"
            type="number"
            min={1}
            max={100000}
            value={input.affectedUsers}
            onChange={change('affectedUsers')}
            required
          />
          <ErrorText error={task.error} />
          <div className="row field-note">
            <button type="submit" disabled={task.pending || !service}>
              Submit incident
            </button>
            <button
              type="button"
              className="secondary"
              disabled={task.pending || !service}
              onClick={() =>
                task.run(async () => {
                  const { category } = await post('/incidents/suggest-category', form);
                  if (!category) throw new Error('No category could be suggested. Please choose one.');
                  setInput((old) => ({ ...old, category }));
                })
              }
            >
              Suggest category
            </button>
          </div>
        </form>
      )}
      {duplicate && (
        <Modal
          title="Possible duplicate"
          submitLabel="Submit anyway"
          onClose={() => setDuplicate(null)}
          onSubmit={() => submit(true)}
        >
          <p>This looks like an incident that is already reported.</p>
          <ul>
            {duplicate.map((d, index) => (
              <li key={d.id || index}>
                {d.id && d.id + ' · '}
                {d.title} ({Math.round(d.score * 100)}% similarity)
              </li>
            ))}
          </ul>
          <p className="muted">Submit anyway as a new incident?</p>
        </Modal>
      )}
      {created && (
        <Modal
          title="Incident reported"
          onClose={() => {
            setCreated(null);
            onReported(created.id);
          }}
        >
          <div className="stack">
            <strong>Incident {created.id} created.</strong>
            <p>
              Category: {created.category} · Priority: {created.priority}
            </p>
            <p>
              Response due {when(created.sla.responseDue)} · Resolution due{' '}
              {when(created.sla.resolutionDue)}
            </p>
            <p>
              {created.technicianName
                ? 'Assigned to ' + created.technicianName + '.'
                : 'Waiting for manual assignment.'}
            </p>
            {created.relatedCount > 0 && (
              <p>
                {created.relatedCount} possibly related{' '}
                {created.relatedCount === 1 ? 'incident' : 'incidents'}.
              </p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

export const capacityTone = (load, max) => (load >= max ? 'red' : load / max >= 0.7 ? 'amber' : 'blue');
const workloadEvents = ['incident-changed', 'workload-changed'];
export function Workload({ active, onUpdate }) {
  const query = useJson('/workload', { active, poll: 10000, events: workloadEvents }),
    task = useTask();
  const data = query.data;
  if (!data) return <LoadStatus {...query} />;
  const { user, active: count, resolved } = data;
  const ratio = count / user.maxConcurrent;
  return (
    <div className="stack">
      <ErrorText error={task.error || query.error} />
      <div className="stats">
        <Stat
          label="ACTIVE INCIDENTS"
          value={count + ' / ' + user.maxConcurrent}
          description={Math.round(ratio * 100) + '% of capacity'}
          tone="blue"
        />
        <Stat
          label="RESOLVED / CLOSED"
          value={resolved}
          description="completed incidents"
          tone="green"
        />
        <Stat
          label="EXPERIENCE"
          value={user.experienceYears + ' yrs'}
          description={user.teamLead ? 'Team Lead' : 'Technician'}
          tone="purple"
        />
        <Stat
          label="AVAILABILITY"
          value={user.available ? 'Available' : 'Unavailable'}
          description={user.available ? 'receiving new assignments' : 'excluded from assignment'}
          tone="teal"
        />
      </div>
      <Bars
        title="Capacity used"
        rows={[
          {
            label: 'Active load',
            value: count,
            max: user.maxConcurrent,
            text: count + ' / ' + user.maxConcurrent,
            tone: capacityTone(count, user.maxConcurrent),
          },
        ]}
      />
      <section className="card">
        <h2>Skills (categories I am matched on)</h2>
        <div className="row">
          {user.skills.map((s) => (
            <Pill key={s} tone="blue">
              {s}
            </Pill>
          ))}
        </div>
      </section>
      <div className="row">
        <button
          disabled={task.pending}
          onClick={() =>
            task.run(async () => {
              onUpdate(await patch('/workload', { available: !user.available }));
              query.refresh();
            })
          }
        >
          Toggle availability
        </button>
        <button className="secondary" onClick={query.refresh}>
          Refresh
        </button>
      </div>
    </div>
  );
}

const inboxEvents = ['notification', 'inbox-changed'];
export function Notifications({ active }) {
  const [page, setPage] = useState(1);
  const query = useJson('/notifications' + queryString({ page }), {
    active,
    poll: 10000,
    events: inboxEvents,
  });
  const task = useTask();
  const mark = (path) =>
    task.run(async () => {
      await patch(path);
      query.refresh();
    });
  const d = query.data;
  return (
    <div className="stack">
      <LoadStatus {...query} />
      <ErrorText error={task.error} />
      {d && (
        <>
          <div className="row">
            <button className="secondary" onClick={query.refresh}>
              Refresh
            </button>
            <button disabled={!d.unread || task.pending} onClick={() => mark('/notifications/read-all')}>
              Mark all as read
            </button>
            <span className="summary">
              {d.total ? d.unread + ' unread of ' + d.total + ' notifications' : 'No notifications yet.'}
            </span>
          </div>
          <Table
            rows={d.rows}
            label="Notifications"
            empty="No notifications yet."
            columns={[
              { key: 'read', title: 'Read', render: (n) => <Pill value={n.read ? 'read' : 'unread'} /> },
              { key: 'createdAt', title: 'Time', render: (n) => when(n.createdAt) },
              { key: 'incidentId', title: 'Incident' },
              { key: 'subject', title: 'Subject' },
              { key: 'message', title: 'Message' },
              {
                key: 'action',
                title: 'Action',
                render: (n) =>
                  !n.read && (
                    <button
                      className="secondary"
                      disabled={task.pending}
                      onClick={() => mark('/notifications/' + n.id + '/read')}
                    >
                      Mark as read
                    </button>
                  ),
              },
            ]}
          />
          <Pager {...d} onPage={setPage} />
        </>
      )}
    </div>
  );
}
