import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoServerError } from 'mongodb';
import snapshot from '../server/seed/snapshot.json' with { type: 'json' };
import { prepareUser } from '../server/accounts.js';
import {
  act,
  assignedTechnician,
  databaseProcess,
  fixture,
  incidentInput,
  investigate,
  report,
  samples,
  signIn,
  signedIn,
  upstream,
} from './support.js';

async function connectStream(api) {
  const controller = new AbortController();
  const response = await api.raw('/events', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  async function next() {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf('\n\n'),
      message = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return message;
  }
  const connection = { abort: () => controller.abort(), next };
  try {
    assert.match((await next()) || '', /retry: 5000/);
  } catch (error) {
    connection.abort();
    throw error;
  }
  return connection;
}

test(
  'API42 live changes reach their audience and clean up on disconnect',
  { timeout: 12000 },
  async (t) => {
    const f = await fixture(t, mongo);
    await f.client()('/events', { expect: 401 });
    const { api: admin, user } = await signedIn(f, 'admin');
    const { api: outside } = await signedIn(f, 'outsider');
    const { api: reporter } = await signedIn(f, 'employee');
    const watchers = [];
    try {
      watchers.push(
        await connectStream(admin),
        await connectStream(outside),
        await connectStream(reporter),
      );
      const incident = await report(reporter);
      const messages = [];
      for (let n = 0; n < 5; n++) {
        messages.push(await watchers[0].next());
        if (
          messages.some((msg) => msg?.startsWith('event: notification\n')) &&
          messages.some((msg) => msg?.startsWith('event: dashboard-changed\n')) &&
          messages.some((msg) => msg?.startsWith('event: incident-changed\n'))
        )
          break;
      }
      assert(messages.some((msg) => msg?.includes('event: dashboard-changed')));
      assert(
        messages.some((msg) => msg?.includes('event: incident-changed') && msg.includes(incident.id)),
      );
      const notice = JSON.parse(
        messages.find((msg) => msg?.startsWith('event: notification\n')).split('\ndata: ')[1],
      );
      assert.deepEqual(Object.keys(notice).sort(), ['id', 'incidentId', 'subject', 'type']);
      assert.equal(notice.incidentId, incident.id);
      assert((await admin('/notifications')).rows.some((row) => row.id === notice.id));
      const outsideResult = await Promise.race([watchers[1].next(), delay(300, 'quiet')]);
      assert.equal(outsideResult, 'quiet');
      for (let n = 0; n < 4; n++) watchers.push(await connectStream(admin));
      assert.equal(f.repo.live.count(user.id), 5);
      await admin('/events', { expect: 429 });
    } finally {
      for (const watcher of watchers) watcher.abort();
    }
    for (let attempt = 0; attempt < 30 && f.repo.live.count(); attempt++) await delay(50);
    assert.equal(f.repo.live.count(), 0);
  },
);

test('API43 only committed callbacks survive a MongoDB transaction retry', async (t) => {
  const f = await fixture(t, mongo);
  const received = [];
  let attempt = 0;
  const result = await f.repo.change(async (unit) => {
    const current = ++attempt;
    await unit.notifications.insert({ _id: 'retry-test', attempt: current });
    unit.afterCommit(() => received.push(current));
    if (current === 1) {
      const retry = new MongoServerError({ message: 'Test retry', code: 112 });
      retry.addErrorLabel('TransientTransactionError');
      throw retry;
    }
    return current;
  });
  assert.equal(result, 2);
  assert.deepEqual(received, [2]);
  assert.equal(
    await f.raw((db) => db.collection('notifications').countDocuments({ _id: 'retry-test' })),
    1,
  );

  await assert.rejects(
    f.repo.change(async (unit) => {
      await unit.notifications.insert({ _id: 'rollback-test' });
      unit.afterCommit(() => received.push('roll back'));
      throw new Error('Abort this test transaction.');
    }),
    /Abort this test/,
  );
  assert.deepEqual(received, [2]);
  assert.equal(
    await f.raw((db) => db.collection('notifications').countDocuments({ _id: 'rollback-test' })),
    0,
  );
});

test('API44 one predictive SLA alert reaches the assignee and admins, with no SMS', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const { api: admin } = await signedIn(f, 'admin');
  const start = new Date(Date.now() - 86400000);
  const closed = Array.from({ length: 10 }, (_, index) => {
    const id = 'fixture-closed-' + index;
    return {
      _id: id,
      id,
      title: 'Fixture SLA history',
      description: 'Historical terminal support test.',
      category: 'Application',
      service: 'SVC1',
      reporter: 'E101',
      priority: 'P1',
      status: 'CLOSED',
      createdAt: start,
      closedAt: new Date(+start + 60 * 60000),
      resolvedAt: new Date(+start + (index === 0 ? 10 : 40) * 60000),
      relatedIds: [],
      sla: {
        startedAt: start,
        resolvedAt: new Date(+start + (index === 0 ? 10 : 40) * 60000),
        responseDue: new Date(+start + 5 * 60000),
        resolutionDue: new Date(+start + 30 * 60000),
        respondedAt: start,
        log: [],
      },
    };
  });
  await f.raw((db) => db.collection('incidents').insertMany(closed));
  const incident = await report(reporter);
  const before = await admin('/admin/dashboard');
  assert.equal(incident.slaStatus, 'ON_TRACK');
  assert.equal(incident.slaRisk.level, 'HIGH');
  assert(incident.slaRisk.probability >= 0.8);
  assert(before.predictedQueue.some((row) => row.id === incident.id));
  assert(before.predictedToBreach >= 1);
  const setting = await admin('/admin/settings');
  assert.equal(setting.riskThresholdPercent, 70);
  const config = {
    assignmentStrategyKey: setting.assignmentStrategyKey,
    priorityStrategyKey: setting.priorityStrategyKey,
    escalationStepMinutes: setting.escalationStepMinutes,
    warnPercent: 75,
  };
  await admin('/admin/settings', {
    method: 'PATCH',
    body: { ...config, riskThresholdPercent: 100 },
    expect: 400,
  });
  await admin('/admin/settings', { method: 'PATCH', body: { ...config, riskThresholdPercent: 99 } });
  assert(!(await admin('/admin/dashboard')).predictedQueue.some((row) => row.id === incident.id));
  await admin('/admin/settings', { method: 'PATCH', body: { ...config, riskThresholdPercent: 70 } });
  await Promise.all([
    admin('/admin/monitor', { method: 'POST' }),
    admin('/admin/monitor', { method: 'POST' }),
  ]);
  await admin('/admin/monitor', { method: 'POST' });
  const details = await reporter('/incidents/' + incident.id);
  assert.equal(details.sla.riskNotified, true);
  assert.equal(details.history.filter((event) => event.action === 'SLA_RISK_PREDICTED').length, 1);
  const channelFilter = { incidentId: incident.id, subject: /predicted SLA breach/ };
  const read = await f.raw(async (db) => ({
    app: await db.collection('notifications').find(channelFilter).toArray(),
    email: await db.collection('emailOutbox').countDocuments(channelFilter),
    sms: await db.collection('smsOutbox').countDocuments(channelFilter),
  }));
  assert(read.app.some((row) => row.recipientId === incident.assignedTo));
  assert(read.app.some((row) => row.recipientId === 'A301'));
  assert(!read.app.some((row) => row.recipientId === 'E101'));
  assert.equal(read.email, read.app.length);
  assert.equal(read.sms, 0);
});

let mongo;
before(
  async () => {
    mongo = await databaseProcess();
  },
  { timeout: 120000 },
);
after(async () => {
  if (mongo) await mongo.close();
});

async function reporterAndTechnician(f) {
  const { api: reporter } = await signedIn(f, 'employee');
  const incident = await report(reporter);
  const technician = await assignedTechnician(f, incident);
  return { reporter, incident, technician };
}

async function onlyTechnician(admin, chosenId, maxConcurrent) {
  const { rows } = await admin('/admin/users');
  for (const user of rows.filter((user) => user.role === 'TECHNICIAN')) {
    const eligible = user.id === chosenId;
    await admin('/admin/users/' + user.id, {
      method: 'PATCH',
      body: {
        skills: user.skills,
        experienceYears: user.experienceYears,
        teamLead: user.teamLead,
        available: eligible,
        maxConcurrent: eligible ? maxConcurrent : user.maxConcurrent,
      },
    });
  }
}

test('API01 imports the complete demo dataset and reports MongoDB health', async (t) => {
  const f = await fixture(t, mongo);
  const health = await f.client()('/health');
  assert.equal(health.database, 'MongoDB');
  const collections = [
    'incidents',
    'users',
    'categories',
    'services',
    'policies',
    'audit',
    'notifications',
    'emailOutbox',
  ];
  const actual = await f.raw((db) =>
    Promise.all(collections.map((name) => db.collection(name).countDocuments())),
  );
  assert.deepEqual(
    actual,
    collections.map((name) => snapshot[name].length),
  );
});

test('API02 sign-in sets a session cookie and exposes public account fields only', async (t) => {
  const f = await fixture(t, mongo);
  const api = f.client();
  await api('/incidents', { expect: 401 });
  const response = await api.raw('/auth/login', {
    method: 'POST',
    body: { email: 'Ravi', password: samples.employee[1] },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /;\s*HttpOnly\b/i);
  assert.match(response.headers.get('set-cookie'), /;\s*SameSite=Strict\b/i);
  const employee = await response.json();
  assert.equal(employee.id, 'E101');
  assert.equal(employee.role, 'EMPLOYEE');
  assert(!Object.hasOwn(employee, 'passwordHash'));
  assert.equal((await api('/auth/me')).id, employee.id);

  const { api: admin } = await signedIn(f, 'admin');
  const { rows } = await admin('/admin/users');
  assert(rows.every((user) => !Object.hasOwn(user, 'passwordHash')));
});

test('API03 everyone can filter the incident list within their own scope', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee } = await signedIn(f, 'employee');
  const { api: technician } = await signedIn(f, 'technician');
  const { api: admin } = await signedIn(f, 'admin');

  assert.deepEqual(
    (await employee('/incidents')).rows.map((row) => row.id),
    ['INC1008', 'INC1001'],
  );
  assert.deepEqual(
    (await employee('/incidents?text=SSO')).rows.map((row) => row.id),
    ['INC1008'],
  );
  assert.equal((await employee('/incidents?text=Payment%20transaction')).summary.total, 0);
  await employee('/incidents/INC1005', { expect: 404 });
  const { rows: assigned } = await technician('/incidents?queue=assigned&service=SVC2');
  assert.deepEqual(
    assigned.map((row) => row.id),
    ['INC1008'],
  );
  assert.equal((await admin('/incidents?text=%2E%2A')).summary.total, 0);
});

test('API04 the dashboard aggregates incidents and includes daily volume and every service', async (t) => {
  const f = await fixture(t, mongo);
  const latest = Math.max(...snapshot.incidents.map((row) => Date.parse(row.createdAt)));
  await f.raw((db) =>
    db
      .collection('settings')
      .updateOne({ _id: 'global' }, { $set: { clockOffsetMinutes: (latest - Date.now()) / 60000 + 2 } }),
  );
  const { api: employee } = await signedIn(f, 'employee');
  await employee('/admin/dashboard', { expect: 403 });
  const { api: admin } = await signedIn(f, 'admin');
  const d = await admin('/admin/dashboard');

  assert.deepEqual([d.total, d.open, d.critical, d.resolutionMinutes], [11, 7, 4, 45]);
  assert.deepEqual(
    d.byPriority.map((p) => p.value),
    [5, 3, 1, 2],
  );
  assert.equal(
    d.volume.reduce((sum, day) => sum + day.count, 0),
    d.total,
  );
  assert(d.volume.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)));

  const service = await admin('/admin/services', {
    method: 'POST',
    body: { name: 'Ninth service', criticality: 'MEDIUM', defaultCategory: 'Application' },
    expect: 201,
  });
  await report(employee, incidentInput({ service: service.id, force: true }));
  const expanded = await admin('/admin/dashboard');
  assert.equal(expanded.byService.length, 9);
  assert(expanded.byService.some((entry) => entry.label === service.name && entry.value === 1));
});

test('API05 the configured foreign origin cannot submit a JSON write', async (t) => {
  const f = await fixture(t, mongo);
  const api = f.client();
  await api('/auth/register', {
    method: 'POST',
    headers: { origin: 'http://localhost:1234' },
    body: { name: 'Blocked Registration', email: 'blocked', password: 'Example123' },
    expect: 403,
  });
});

test('API06 a secure public origin works behind a local proxy and sets Secure', async (t) => {
  const origin = 'https://desk.example.test';
  const f = await fixture(t, mongo, { publicOrigin: origin, trustProxy: 'loopback' });
  const headers = {
    host: 'desk.example.test',
    origin,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '192.0.2.21',
  };
  const [email, password] = samples.employee;
  const login = await upstream(f.origin, '/auth/login', headers, { email, password });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'][0], /;\s*Secure\b/i);
  const mismatch = await upstream(
    f.origin,
    '/auth/login',
    { ...headers, origin: 'http://desk.example.test' },
    { email, password },
  );
  assert.equal(mismatch.statusCode, 403);
});

test('API07 reports have unique IDs, classifying audit events, and idempotent retries', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee } = await signedIn(f, 'employee');
  const body = incidentInput();
  const first = await report(employee, body);

  assert.equal(first.id, 'INC1012');
  assert.equal(first.priority, 'P1');
  assert.equal(first.status, 'ASSIGNED');
  assert.equal(first.sla.policyName, 'Gold');
  const actions = first.history.map((event) => event.action);
  assert.deepEqual(actions.slice(0, 3), ['CREATED', 'CLASSIFIED', 'PRIORITY_CALCULATED']);

  const retries = await Promise.all([report(employee, body), report(employee, body)]);
  for (const retry of retries) {
    assert.equal(retry.id, first.id);
    assert.equal(retry.history.length, first.history.length);
  }
});

test('API08 duplicate warnings do not expose another employee’s incident details', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee } = await signedIn(f, 'employee');
  const { api: outsider } = await signedIn(f, 'outsider');
  const body = incidentInput();
  const i = await report(employee, body);
  const duplicate = await outsider('/incidents', {
    method: 'POST',
    body: { ...body, requestId: randomUUID() },
    expect: 409,
  });

  assert.equal(duplicate.code, 'DUPLICATE');
  assert(duplicate.candidates.length > 0);
  assert(!duplicate.candidates.some((c) => c.id === i.id || c.title === body.title));
});

test('API09 adding related IDs preserves the actionable version', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const body = incidentInput();
  const first = await report(reporter, body);
  const technician = await assignedTechnician(f, first);

  const second = await report(reporter, { ...body, requestId: randomUUID(), force: true });
  const updated = await reporter('/incidents/' + first.id);
  assert(updated.relatedIds.includes(second.id));
  assert.equal(updated.version, first.version);
  await act(technician, first.id, 'acknowledge', { version: first.version });
  assert.equal((await reporter('/incidents/' + first.id)).status, 'ACKNOWLEDGED');
});

test('API10 a stale workflow action returns a conflict and leaves state intact', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  await act(technician, incident.id, 'acknowledge', { version: incident.version });
  await act(technician, incident.id, 'investigate', { version: incident.version }, 409);
  assert.equal((await reporter('/incidents/' + incident.id)).status, 'ACKNOWLEDGED');
});

test('API11 the lifecycle resolves, reopens, verifies, and closes a ticket', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  const { id } = incident;
  await act(technician, id, 'resolve', { text: 'Trying to resolve before investigation.' }, 409);
  await investigate(technician, incident);
  await act(technician, id, 'request-info', { text: 'Which terminal displayed the labels?' });
  await act(reporter, id, 'reply', { text: 'The terminal next to reception.' });
  await act(technician, id, 'resolve', {
    text: 'Restored the previous label order and confirmed the terminal displays it.',
  });
  await act(reporter, id, 'verify', {
    accepted: false,
    comment: 'The second screen has the same issue.',
  });
  await act(technician, id, 'resolve', { text: 'Both terminals display the correct label order.' });
  await act(reporter, id, 'verify', { accepted: true, rating: 5, comment: 'Both corrected.' });
  await act(technician, id, 'close', { text: 'Employee confirmed the fix.' });

  const closed = await reporter('/incidents/' + id);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.feedback.rating, 5);
  assert(closed.notes.some((note) => note.kind === 'REOPEN_REASON'));
});

test('API12 a signed-in employee cannot perform technician work', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const incident = await report(reporter);
  await act(reporter, incident.id, 'acknowledge', {}, 403);
  const { api: outsider } = await signedIn(f, 'outsider');
  await act(outsider, incident.id, 'verify', { accepted: true, rating: 5 }, 404);
});

test('API13 the assignment recommendations endpoint enforces administrator access', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee } = await signedIn(f, 'employee');
  const { api: admin } = await signedIn(f, 'admin');
  const path = '/incidents/INC1008/recommendations';
  await employee(path, { expect: 403 });

  const { ranking, strategy } = await admin(path);
  assert.equal(strategy, 'SKILL');
  assert(ranking.length > 0);
  assert(ranking[0].id);
  assert(ranking.every((row, index) => index === 0 || ranking[index - 1].score >= row.score));
});

test('API14 a resolution suggestion returns a similar fix visible to the assignee', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const { api: technician, user } = await signedIn(f, 'technician');
  await onlyTechnician(admin, user.id, 7);

  const seed = incidentInput();
  const first = await report(employee, seed);
  assert.equal(first.assignedTo, user.id);
  await investigate(technician, first);
  const fix = 'Reapplied the machine labels and calibrated the optical reader.';
  await act(technician, first.id, 'resolve', { text: fix });

  const second = await report(employee, { ...seed, requestId: randomUUID(), force: true });
  assert.equal(second.assignedTo, user.id);
  const path = '/incidents/' + second.id + '/resolutions';
  await employee(path, { expect: 403 });
  const otherTechnician = f.client();
  await signIn(otherTechnician, ['priya', 'Tech@1234']);
  await otherTechnician(path, { expect: 404 });
  const suggestions = await technician(path);
  assert(suggestions.some((s) => s.id === first.id && s.resolution === fix && s.score >= 0.35));
});

test('API15 notification read actions are restricted to the recipient', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee, user } = await signedIn(f, 'employee');
  const { api: outsider } = await signedIn(f, 'outsider');
  const inbox = await employee('/notifications');
  assert(inbox.rows.every((row) => row.recipientId === user.id));
  const notice = inbox.rows.find((row) => !row.read);
  assert(notice, 'Demo employee must begin with an unread notice');

  await outsider('/notifications/' + notice.id + '/read', { method: 'PATCH', expect: 404 });
  await employee('/notifications/' + notice.id + '/read', { method: 'PATCH' });
  assert.equal((await employee('/notifications')).unread, inbox.unread - 1);
  await employee('/notifications/read-all', { method: 'PATCH' });
  assert.equal((await employee('/notifications')).unread, 0);
});

test('API16 the administrator Outbox shows simulated email and SMS', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee } = await signedIn(f, 'employee');
  const { api: admin } = await signedIn(f, 'admin');
  const incident = await report(employee);
  await employee('/admin/outbox', { expect: 403 });

  for (const channel of ['EMAIL', 'SMS']) {
    const page = await admin('/admin/outbox?channel=' + channel);
    assert.equal(page.page, 1);
    assert(page.total > 0);
    assert(page.rows.every((row) => row.channel === channel));
    assert(page.rows.some((row) => row.subject.includes(incident.id) && row.state === 'SIMULATED'));
  }
});

test('API17 a referenced category cannot be deleted until its service is removed', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const category = await admin('/admin/categories', {
    method: 'POST',
    body: { name: 'Telephony', keywords: 'voip, phone' },
    expect: 201,
  });
  const suggestion = await employee('/incidents/suggest-category', {
    method: 'POST',
    body: { service: 'SVC1', title: 'The voip headset has no sound' },
  });
  assert.equal(suggestion.category, category.id);
  const service = await admin('/admin/services', {
    method: 'POST',
    body: { name: 'Telephony Demo', criticality: 'LOW', defaultCategory: category.id },
    expect: 201,
  });
  await admin('/admin/categories/Telephony', { method: 'DELETE', expect: 409 });
  await admin('/admin/services/' + service.id, { method: 'DELETE' });
  await admin('/admin/categories/Telephony', { method: 'DELETE' });
});

test('API18 the escalation monitor advances an unacknowledged P1 through three levels', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const incident = await report(employee);
  const levels = ['Team Lead', 'System Administrator', 'IT Manager'];

  for (const [index, level] of levels.entries()) {
    await admin('/admin/clock', { method: 'POST', body: { minutes: index === 0 ? 6 : 10 } });
    const progressed = await employee('/incidents/' + incident.id);
    assert.equal(progressed.escalationLevel, index + 1);
    assert(
      progressed.history.some((row) => row.action === 'ESCALATED' && row.description.includes(level)),
    );
  }
  const violations = await admin('/admin/violations');
  assert(violations.total > 0);
});

test('API19 pending information pauses resolution and preserves the response deadline', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  const { api: admin } = await signedIn(f, 'admin');
  const { id } = incident;
  await investigate(technician, incident);
  await act(technician, id, 'request-info', { text: 'Can you identify the affected terminal?' });
  const pending = await reporter('/incidents/' + id);
  assert.equal(pending.status, 'PENDING_INFO');
  assert(pending.sla.pausedAt);
  await admin('/admin/clock', { method: 'POST', body: { minutes: 60 } });
  const paused = await reporter('/incidents/' + id);
  assert(!paused.sla.resolutionBreached);
  assert.equal(paused.slaStatus, 'PAUSED');
  assert((await reporter('/incidents?sla=PAUSED')).rows.some((row) => row.id === id));

  await act(reporter, id, 'reply', { text: 'It is the terminal beside the entrance.' });
  const resumed = await reporter('/incidents/' + id);
  assert.equal(resumed.status, 'IN_PROGRESS');
  assert.equal(resumed.sla.pausedAt, null);
  assert.equal(resumed.sla.responseDue, pending.sla.responseDue);
  assert(resumed.sla.totalPausedMs >= 3600000);
  assert.equal(
    Date.parse(resumed.sla.resolutionDue) - Date.parse(pending.sla.resolutionDue),
    resumed.sla.totalPausedMs,
  );
});

test('API20 three recent open incidents on a service trigger outage correlation', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const service = await admin('/admin/services', {
    method: 'POST',
    body: { name: 'Training outage exercise', criticality: 'HIGH', defaultCategory: 'Application' },
    expect: 201,
  });
  const incoming = ['Sign-on outage', 'Network timeout at kiosk', 'Point-of-sale freezes'];
  const ids = [];
  for (const title of incoming)
    ids.push((await report(employee, incidentInput({ title, service: service.id, force: true }))).id);

  const last = await admin('/incidents/' + ids.at(-1));
  assert(last.history.some((row) => row.action === 'OUTAGE_SUSPECTED'));
  const dashboard = await admin('/admin/dashboard');
  assert(
    dashboard.outages.some(
      (row) =>
        row.service === service.name &&
        row.count === incoming.length &&
        ids.every((id) => row.incidents.includes(id)),
    ),
  );
});

test('API21 invalid incident title, feedback rating, and password return 400', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  await reporter('/incidents', { method: 'POST', body: incidentInput({ title: 'Bad' }), expect: 400 });

  await investigate(technician, incident);
  await act(technician, incident.id, 'resolve', {
    text: 'Restored the package and checked the station.',
  });
  await act(reporter, incident.id, 'verify', { accepted: true, rating: 6 }, 400);
  assert.equal((await reporter('/incidents/' + incident.id)).status, 'RESOLVED');

  await f.client()('/auth/register', {
    method: 'POST',
    body: { name: 'Invalid Password', email: 'invalid', password: 'letters-only' },
    expect: 400,
  });
});

test('API22 selecting the RULES strategy alters priority on the next incident', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const settings = await admin('/admin/settings');
  await admin('/admin/settings', {
    method: 'PATCH',
    body: {
      assignmentStrategyKey: settings.assignmentStrategyKey,
      priorityStrategyKey: 'RULES',
      escalationStepMinutes: settings.escalationStepMinutes,
      warnPercent: settings.slaWarningFraction * 100,
    },
  });

  const decision = await report(
    employee,
    incidentInput({
      service: 'SVC8',
      category: 'Security',
      impact: 'HIGH',
      urgency: 'LOW',
      affectedUsers: 1,
    }),
  );
  assert.equal(decision.priority, 'P1');
  assert(decision.history.some((row) => row.action === 'PRIORITY_CALCULATED'));
});

test('API23 normalized login failures temporarily lock only that account', async (t) => {
  const f = await fixture(t, mongo);
  const api = f.client();
  const response = await api('/auth/login', {
    method: 'POST',
    body: { email: 'missing', password: 'Incorrect9' },
    expect: 401,
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const failed = await api('/auth/login', {
      method: 'POST',
      body: { email: attempt % 2 ? 'ravi@nexora.com' : 'RAVI', password: 'Incorrect9' },
      expect: 401,
    });
    assert.equal(failed.message, response.message);
  }
  await api('/auth/login', {
    method: 'POST',
    body: { email: 'ravi', password: samples.employee[1] },
    expect: 429,
  });
  const unaffected = await signIn(api, samples.outsider);
  assert.equal(unaffected.id, 'E102');
});

test('API24 the IP limiter throttles attempts across different account identifiers', async (t) => {
  const f = await fixture(t, mongo, { authLimits: { ipLimit: 3, accountLimit: 5 } });
  const api = f.client();
  for (let attempt = 0; attempt < 3; attempt++) {
    await api('/auth/login', {
      method: 'POST',
      body: { email: 'missing-' + attempt, password: 'Incorrect9' },
      expect: 401,
    });
  }
  await api('/auth/login', {
    method: 'POST',
    body: { email: 'ravi', password: samples.employee[1] },
    expect: 429,
  });
});

test('API25 demo samples are available only when demo mode is enabled', async (t) => {
  const demo = await fixture(t, mongo);
  assert.equal((await demo.client()('/auth/options')).demo, true);
  assert.equal((await demo.client()('/auth/samples')).length, 3);

  const bootstrapPassword = 'StaffExample76';
  const bootstrapAccount = await prepareUser(
    {
      name: 'Fixture Staff Owner',
      email: 'fixture-admin@nexora.com',
      password: bootstrapPassword,
    },
    'ADMINISTRATOR',
    'nexora.com',
  );
  const privateSite = await fixture(t, mongo, {
    demoMode: false,
    databaseOptions: { demoMode: false, bootstrapAccount },
  });
  const api = privateSite.client();
  const options = await api('/auth/options');
  assert.equal(options.demo, false);
  assert.equal(options.google, false);
  assert.deepEqual(await api('/auth/samples'), []);
  const [email, password] = samples.admin;
  await api('/auth/login', { method: 'POST', body: { email, password }, expect: 401 });
  const admin = await signIn(api, ['fixture-admin@nexora.com', bootstrapPassword]);
  assert.equal(admin.role, 'ADMINISTRATOR');
});

test('API26 self-registration creates employee accounts only', async (t) => {
  const f = await fixture(t, mongo);
  const api = f.client();
  const user = await api('/auth/register', {
    method: 'POST',
    body: {
      name: 'New colleague',
      email: 'new-colleague',
      password: 'Example123',
      role: 'ADMINISTRATOR',
    },
    expect: 201,
  });
  assert.equal(user.role, 'EMPLOYEE');
  assert(!Object.hasOwn(user, 'passwordHash'));
  await signIn(api, [user.email, 'Example123']);
  await api('/admin/users', { expect: 403 });
});

test('API27 a password change invalidates old credentials and the other session', async (t) => {
  const f = await fixture(t, mongo);
  const primary = f.client();
  const secondary = f.client();
  const [email, password] = samples.employee;
  await signIn(primary, [email, password]);
  await signIn(secondary, [email, password]);
  await primary('/auth/password', {
    method: 'PATCH',
    body: { current: password, password: 'Changed456' },
  });
  await secondary('/auth/me', { expect: 401 });
  const sample = (await primary('/auth/samples')).find((account) =>
    account.email.startsWith(email + '@'),
  );
  assert.equal(sample.password, null);
  await primary('/auth/logout', { method: 'POST' });
  await primary('/auth/login', { method: 'POST', body: { email, password }, expect: 401 });
  assert.equal((await signIn(primary, [email, 'Changed456'])).id, 'E101');
});

test('API28 deactivation revokes sessions for the affected account', async (t) => {
  const f = await fixture(t, mongo);
  const { api: employee, user } = await signedIn(f, 'employee');
  const { api: admin } = await signedIn(f, 'admin');
  await admin('/admin/users/' + user.id, { method: 'PATCH', body: { active: false } });
  await employee('/auth/me', { expect: 401 });
});

test('API29 simultaneous reports respect technician capacity without rewriting global settings', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const { api: other } = await signedIn(f, 'outsider');
  const { api: technician, user } = await signedIn(f, 'technician');
  const load = (await technician('/workload')).active;
  await onlyTechnician(admin, user.id, load + 1);
  const settings = () => f.raw((db) => db.collection('settings').findOne({ _id: 'global' }));
  const beforeReports = await settings();

  const [first, second] = await Promise.all([
    report(employee, incidentInput({ title: 'Concurrent terminal incident', force: true })),
    report(other, incidentInput({ title: 'Concurrent kiosk incident', force: true })),
  ]);
  assert.notEqual(first.id, second.id);
  assert.deepEqual([first.status, second.status].sort(), ['ASSIGNED', 'CLASSIFIED']);
  assert.equal((await technician('/workload')).active, load + 1);
  assert.deepEqual(await settings(), beforeReports);
});

test('API30 a reporter can cancel an open incident', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const { api: other } = await signedIn(f, 'outsider');
  const incident = await report(reporter);
  await act(other, incident.id, 'cancel', { text: 'Resolved outside the service desk.' }, 404);
  await act(reporter, incident.id, 'cancel', {
    text: 'Resolved outside the service desk.',
    version: incident.version,
  });
  const cancelled = await reporter('/incidents/' + incident.id);
  assert.equal(cancelled.status, 'CANCELLED');
  assert(cancelled.history.some((row) => row.action === 'CANCELLED'));
});

test('API31 a technician can decline a pending assignment', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  await act(technician, incident.id, 'decline', {
    text: 'This queue is outside my team.',
    version: incident.version,
  });
  const declined = await reporter('/incidents/' + incident.id);
  assert.equal(declined.status, 'CLASSIFIED');
  assert.equal(declined.assignedTo, null);
  assert(declined.history.some((row) => row.action.includes('DECLINED')));
});

test('API32 an administrator can unassign an incident awaiting information', async (t) => {
  const f = await fixture(t, mongo);
  const { reporter, technician, incident } = await reporterAndTechnician(f);
  const { api: admin } = await signedIn(f, 'admin');
  await investigate(technician, incident);
  await act(technician, incident.id, 'request-info', { text: 'Please attach the terminal number.' });
  const pending = await reporter('/incidents/' + incident.id);
  await act(admin, incident.id, 'unassign', {
    text: 'Route the incident to desktop support.',
    version: pending.version,
  });
  const updated = await reporter('/incidents/' + incident.id);
  assert.equal(updated.status, 'CLASSIFIED');
  assert.equal(updated.assignedTo, null);
  assert.equal(updated.sla.pausedAt, null);
  assert(updated.history.some((row) => row.action === 'UNASSIGNED'));
});

test('API33 incident date filters respect the configured site time zone', async (t) => {
  const timeZone = 'America/Los_Angeles';
  const f = await fixture(t, mongo, { timeZone });
  const { api: admin } = await signedIn(f, 'admin');
  // This local day is 25 hours long because clocks move back one hour.
  const times = [
    ['INC1001', '2026-11-01T06:59:59.999Z'],
    ['INC1002', '2026-11-01T07:00:00.000Z'],
    ['INC1003', '2026-11-02T07:59:59.999Z'],
    ['INC1004', '2026-11-02T08:00:00.000Z'],
  ];
  await f.raw((db) =>
    db.collection('incidents').bulkWrite(
      times.map(([id, timestamp]) => ({
        updateOne: { filter: { _id: id }, update: { $set: { createdAt: new Date(timestamp) } } },
      })),
    ),
  );
  const actual = await admin('/incidents?from=2026-11-01&to=2026-11-01');
  assert.deepEqual(actual.rows.map((row) => row.id).sort(), ['INC1002', 'INC1003']);
});

test('API34 administrators can export CSV with spreadsheet-safe user text', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: employee } = await signedIn(f, 'employee');
  const title = '=2+2 sample title';
  const incident = await report(employee, incidentInput({ title }));
  await employee('/admin/report.csv', { expect: 403 });
  const response = await admin.raw('/admin/report.csv');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/i);
  const csv = await response.text();
  assert(csv.includes(incident.id));
  assert(csv.includes("'" + title), 'Formula-like content is exported as text');
});

test('API35 committed role notifications are delivered on an authenticated event stream', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const { api: admin } = await signedIn(f, 'admin');
  await f.client()('/stream', { expect: 401 });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('No notification event arrived.')), 8000);
  try {
    const response = await admin.raw('/stream', { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/i);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const initial = await reader.read();
    assert(!initial.done);
    const incident = await report(reporter);
    let data = '';
    while (!data.includes('event: notifications')) {
      const part = await reader.read();
      assert(!part.done, 'The stream closed before publishing the notification');
      data += decoder.decode(part.value, { stream: true });
    }
    const { rows } = await admin('/notifications');
    assert(rows.some((row) => row.incidentId === incident.id));
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
});

test(
  'API36 incidents and account edits persist through a replica-set restart',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t, mongo);
    const { api: admin } = await signedIn(f, 'admin');
    const { api: employee, user } = await signedIn(f, 'employee');
    const incident = await report(employee);
    await act(employee, incident.id, 'cancel', { text: 'The migration exercise is complete.' });
    await admin('/admin/users/' + user.id, { method: 'PATCH', body: { active: false } });
    await f.stop();

    await mongo.restart();
    await f.raw(async (db) => {
      assert.equal(await db.collection('incidents').countDocuments(), 12);
      assert.equal((await db.collection('incidents').findOne({ _id: incident.id })).status, 'CANCELLED');
      assert.equal((await db.collection('users').findOne({ _id: user.id })).active, false);
    });
  },
);

test('API37 account auditing records login and password changes without credential values', async (t) => {
  const f = await fixture(t, mongo);
  const { api, user } = await signedIn(f, 'employee');
  const current = samples.employee[1];
  const password = 'ChangedFixture456';
  await api('/auth/password', { method: 'PATCH', body: { current, password } });
  const events = await f.raw((db) => db.collection('audit').find({ accountId: user.id }).toArray());
  assert.deepEqual(new Set(events.map((event) => event.action)), new Set(['LOGIN', 'PASSWORD_CHANGED']));
  assert(events.every((event) => event.incidentId === null));
  assert(!JSON.stringify(events).includes(password));
  assert(!JSON.stringify(events).includes(current));
});

test('API38 a version-one database migrates workflow state, counters, and technician loads', async (t) => {
  const dates = new Set([
    'at',
    'timestamp',
    'createdAt',
    'updatedAt',
    'startedAt',
    'respondedAt',
    'resolvedAt',
    'closedAt',
    'passwordChangedAt',
    'responseDue',
    'resolutionDue',
  ]);
  const legacy = JSON.parse(JSON.stringify(snapshot), (key, value) =>
    dates.has(key) && typeof value === 'string' ? new Date(value) : value,
  );
  Object.assign(legacy.settings[0], { schemaVersion: 1, clockOffsetMinutes: 0, revision: 17 });
  const f = await fixture(t, mongo, {
    async beforeConnect(db) {
      for (const [name, rows] of Object.entries(legacy)) {
        if (rows.length) await db.collection(name).insertMany(rows);
      }
    },
  });
  await f.raw(async (db) => {
    const settings = await db.collection('settings').findOne({ _id: 'global' });
    assert.equal(settings.schemaVersion, 2);
    assert(!Object.hasOwn(settings, 'revision'));
    assert.equal((await db.collection('counters').findOne({ _id: 'INC' })).value, 11);
    assert.equal((await db.collection('users').findOne({ _id: 'T204' })).activeLoad, 2);
    const waiting = await db.collection('incidents').findOne({ _id: 'INC1011' });
    assert.equal(waiting.status, 'PENDING_INFO');
    assert(waiting.sla.pausedAt instanceof Date);
    assert.equal(waiting.sla.totalPausedMs, 0);
  });
  const { api } = await signedIn(f, 'employee');
  assert.equal((await report(api)).id, 'INC1012');
});

test('API39 concurrent password updates with the same starting credentials accept only one', async (t) => {
  const f = await fixture(t, mongo);
  const primary = f.client(),
    secondary = f.client();
  const [email, current] = samples.employee;
  await Promise.all([signIn(primary, [email, current]), signIn(secondary, [email, current])]);
  const candidates = ['WinningCandidate46', 'WinningCandidate47'];
  const updates = await Promise.all(
    [primary, secondary].map((api, index) =>
      api.raw('/auth/password', {
        method: 'PATCH',
        body: { current, password: candidates[index] },
      }),
    ),
  );
  const codes = updates.map((r) => r.status);
  for (const response of updates) await response.json();
  assert.equal(codes.filter((code) => code === 200).length, 1);
  assert(
    codes.every((code) => [200, 401, 409].includes(code)),
    JSON.stringify(codes),
  );
  const winner = candidates[codes.indexOf(200)];
  assert.equal((await signIn(f.client(), [email, winner])).id, 'E101');
});

test('API40 concurrent initial submissions with one request ID create one incident', async (t) => {
  const f = await fixture(t, mongo);
  const { api: reporter } = await signedIn(f, 'employee');
  const body = incidentInput();
  const [first, second] = await Promise.all([report(reporter, body), report(reporter, body)]);
  assert.equal(first.id, second.id);
  assert.equal(
    await f.raw((db) => db.collection('incidents').countDocuments({ requestId: body.requestId })),
    1,
  );
  assert.equal(first.history.filter((row) => row.action === 'CREATED').length, 1);
});

test('API41 a simultaneous service removal and report cannot create a broken reference', async (t) => {
  const f = await fixture(t, mongo);
  const { api: admin } = await signedIn(f, 'admin');
  const { api: reporter } = await signedIn(f, 'employee');
  const service = await admin('/admin/services', {
    method: 'POST',
    body: { name: 'Service retirement', criticality: 'HIGH', defaultCategory: 'Application' },
    expect: 201,
  });
  const body = incidentInput({ service: service.id });
  const [submitted, removed] = await Promise.all([
    reporter.raw('/incidents', { method: 'POST', body }),
    admin.raw('/admin/services/' + service.id, { method: 'DELETE' }),
  ]);
  await submitted.json();
  await removed.json();
  assert(
    (submitted.status === 201 && removed.status === 409) ||
      ([404, 409].includes(submitted.status) && removed.status === 200),
    'Unexpected responses ' + submitted.status + ' and ' + removed.status,
  );
  await f.raw(async (db) => {
    const uses = await db.collection('incidents').countDocuments({ service: service.id });
    const stored = await db.collection('services').findOne({ _id: service.id });
    if (!stored) assert.equal(uses, 0);
  });
});
