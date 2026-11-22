import test from 'node:test';
import assert from 'node:assert/strict';
import { Incident } from '../server/domain/incident.js';
import { UserFactory, Technician } from '../server/domain/users.js';
import { EventBus, NotificationObserver } from '../server/events.js';
import {
  NotificationChannel,
  InAppChannel,
  EmailChannel,
  SmsChannel,
} from '../server/notifications/channels.js';

test('DOMAIN13 every declared legal lifecycle edge can be applied to the aggregate', () => {
  const edges = {
    NEW: ['CLASSIFIED', 'CANCELLED'],
    CLASSIFIED: ['ASSIGNED', 'CANCELLED'],
    ASSIGNED: ['ACKNOWLEDGED', 'CLASSIFIED', 'CANCELLED'],
    ACKNOWLEDGED: ['IN_PROGRESS', 'CLASSIFIED', 'CANCELLED'],
    IN_PROGRESS: ['PENDING_INFO', 'RESOLVED', 'CLASSIFIED', 'CANCELLED'],
    PENDING_INFO: ['IN_PROGRESS', 'CLASSIFIED', 'CANCELLED'],
    RESOLVED: ['VERIFIED', 'IN_PROGRESS'],
    VERIFIED: ['CLOSED'],
    CLOSED: [],
    CANCELLED: [],
  };
  const when = new Date('2026-01-01T00:00:00Z');
  for (const [from, targets] of Object.entries(edges)) {
    for (const to of Object.keys(edges)) {
      const ticket = Incident.draft({ status: from, sla: { resolutionDue: new Date(+when + 60000) } });
      if (targets.includes(to)) {
        ticket.transition(to, when);
        assert.equal(ticket.state.name, to);
      } else {
        assert.throws(() => ticket.transition(to, when), { status: 409 });
        assert.equal(ticket.state.name, from);
      }
    }
  }
});

test('DOMAIN14 registering a channel delivers notices without changing the core rules', async () => {
  /** Fixture channel exercising the same extension point as built-in adapters. */
  class FakeChannel extends NotificationChannel {
    constructor() {
      super('FAKE');
    }

    /** Record the notice through the shared adapter contract. */
    deliver(notice, recipient, unit) {
      unit.fake.push({ notice, recipient });
    }
  }
  const notices = [],
    emails = [],
    texts = [],
    fake = [];
  const recipient = { id: 'T201', name: 'Example technician', email: 'tech@nexora.com' };
  const reporter = { id: 'E101', name: 'Example reporter', email: 'employee@nexora.com' };
  const unit = {
    notifications: { insert: (row) => notices.push(row) },
    emailOutbox: { insert: (row) => emails.push(row) },
    smsOutbox: { insert: (row) => texts.push(row) },
    users: { find: async () => [reporter, recipient] },
    counters: {
      reserve: async (prefix, count) =>
        Array.from({ length: count }, (_, index) => prefix + (index + 1)),
    },
    fake,
  };
  const bus = new EventBus([
    new NotificationObserver([
      new InAppChannel(),
      new EmailChannel(),
      new SmsChannel(),
      new FakeChannel(),
    ]),
  ]);
  await bus.publish(unit, {
    action: 'ASSIGNED',
    at: new Date(),
    description: 'Assigned',
    incident: {
      id: 'INC42',
      priority: 'P1',
      reporter: reporter.id,
      assignedTo: recipient.id,
    },
  });
  assert.deepEqual(
    notices.map((row) => row.id),
    ['NTF1', 'NTF5'],
  );
  assert.deepEqual(
    emails.map((row) => row.id),
    ['NTF2', 'NTF6'],
  );
  assert.deepEqual(
    texts.map((row) => row.id),
    ['NTF3', 'NTF7'],
  );
  assert.equal(fake[0].notice.subject, 'INC42 [P1] assigned');
  assert.equal(fake[0].recipient.id, reporter.id);
});

test('DOMAIN15 new accounts validate their subtype and hydrate through the same factory', () => {
  const input = {
    name: 'Fixture',
    email: 'fixture@nexora.com',
    passwordHash: 'stored',
    maxConcurrent: 2,
    skills: 'Network, Identity',
  };
  const technician = UserFactory.create('TECHNICIAN', input);
  assert(technician instanceof Technician);
  assert.equal(technician.activeLoad, 0);
  assert.deepEqual(technician.skills, ['Network', 'Identity']);
  assert(UserFactory.from(technician.toDocument()) instanceof Technician);
  assert.throws(() => UserFactory.create('TECHNICIAN', { ...input, maxConcurrent: 0 }), { status: 400 });
});
