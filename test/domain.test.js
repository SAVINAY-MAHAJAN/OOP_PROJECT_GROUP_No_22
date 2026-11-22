import assert from 'node:assert/strict';
import test from 'node:test';
import snapshot from '../server/seed/snapshot.json' with { type: 'json' };
import { rankTechnicians } from '../server/assignment/strategies.js';
import { Incident } from '../server/domain/incident.js';
import { NewState, ClosedState } from '../server/domain/states.js';
import { Administrator, Employee, Technician, User, UserFactory } from '../server/domain/users.js';
import { EventBus, EventObserver } from '../server/events.js';
import { EmailChannel, InAppChannel, SmsChannel } from '../server/notifications/channels.js';
import { similarity } from '../server/nlp/text.js';
import { prioritize } from '../server/priority/strategies.js';
import { findings, newSla, pauseResolution, resumeResolution, slaStatus } from '../server/sla/clock.js';

const start = new Date('2026-01-01T00:00:00Z');
const at = (seconds) => new Date(+start + seconds * 1000);
const gold = snapshot.policies.find((policy) => policy.name === 'Gold');

test('DOMAIN01 weighted priority respects the score and affected-user boundaries', () => {
  const cases = [
    ['HIGH', 'HIGH', 'CRITICAL', 1, 'P1', 36],
    ['HIGH', 'HIGH', 'HIGH', 49, 'P2', 33.75],
    ['HIGH', 'HIGH', 'HIGH', 50, 'P1', 40.5],
    ['HIGH', 'HIGH', 'LOW', 200, 'P2', 18],
    ['MEDIUM', 'HIGH', 'LOW', 9, 'P3', 6],
    ['MEDIUM', 'MEDIUM', 'LOW', 10, 'P4', 5],
  ];
  for (const [impact, urgency, businessCriticality, affectedUsers, priority, score] of cases) {
    const computed = prioritize({ impact, urgency, businessCriticality, affectedUsers }, 'WEIGHTED');
    assert.deepEqual({ priority: computed.priority, score: computed.score }, { priority, score });
  }
});

test('DOMAIN02 ordered business rules select each of the four priorities', () => {
  const cases = [
    ['CRITICAL', 'LOW', 'CRITICAL', 1, null, 'P1'],
    ['HIGH', 'LOW', 'LOW', 1, 'Security', 'P1'],
    ['LOW', 'HIGH', 'LOW', 200, null, 'P1'],
    ['HIGH', 'HIGH', 'LOW', 1, null, 'P2'],
    ['MEDIUM', 'LOW', 'HIGH', 1, null, 'P2'],
    ['LOW', 'MEDIUM', 'LOW', 1, null, 'P3'],
    ['LOW', 'LOW', 'LOW', 1, null, 'P4'],
  ];
  for (const [impact, urgency, businessCriticality, affectedUsers, category, expected] of cases) {
    const decision = prioritize(
      { impact, urgency, businessCriticality, affectedUsers, category },
      'RULES',
    );
    assert.equal(decision.priority, expected);
    assert(decision.reason);
  }
});

test('DOMAIN03 each assignment strategy ranks the same fixture independently', () => {
  const incident = snapshot.incidents.find((row) => row.id === 'INC1009');
  const techs = snapshot.users.filter((row) => row.role === 'TECHNICIAN');
  const expected = [
    ['SKILL', 'T203', 76.5],
    ['LOAD', 'T205', 2],
    ['EXPERIENCE', 'T203', 36],
    ['ROUND_ROBIN', 'T201', 5],
  ];
  for (const [key, id, score] of expected) {
    const [first] = rankTechnicians(incident, techs, snapshot.incidents, { assignmentStrategyKey: key });
    assert.deepEqual({ id: first.id, score: first.score }, { id, score });
  }
});

test('DOMAIN04 round robin starts after the previous assignee and wraps', () => {
  const techs = snapshot.users.filter((row) => row.role === 'TECHNICIAN');
  const rank = (lastAssignedId) =>
    rankTechnicians(snapshot.incidents[0], techs, [], {
      assignmentStrategyKey: 'ROUND_ROBIN',
      lastAssignedId,
    });
  assert.equal(rank('T203')[0].id, 'T204');
  assert.equal(rank('T205')[0].id, 'T201');
});

test('DOMAIN05 normalization and token similarity preserve the known duplicate score', () => {
  const first = snapshot.incidents.find((row) => row.id === 'INC1005');
  const second = snapshot.incidents.find((row) => row.id === 'INC1006');
  assert.equal(similarity(first, second), 0.5625);
  const wordSwap = { ...first, title: 'Payment application down' };
  assert(Math.abs(similarity(first, wordSwap) - 1) < Number.EPSILON);
});

test('DOMAIN06 a new incident cannot transition directly to closed', () => {
  const incident = Incident.draft({ updatedAt: start });
  assert(incident.state instanceof NewState);
  assert.throws(() => incident.transition('CLOSED', at(1)), { status: 409 });
  assert.equal(incident.status, 'NEW');
  assert.equal(incident.updatedAt, start);
});

test('DOMAIN07 the incident aggregate reaches a terminal State through legal operations', () => {
  const incident = Incident.draft({ id: 'INC1999', updatedAt: start });
  incident.classify('P1', newSla(gold, 'P1', start), at(1));
  incident.assign('T201', at(2));
  incident.acknowledge(at(3));
  incident.transition('IN_PROGRESS', at(4));
  incident.resolve('Reset the application configuration.', 'Technician', at(5));
  incident.verify(5, 'Verified', at(6));
  incident.close('Completed', 'Technician', at(7));
  assert(incident.state instanceof ClosedState);
  assert.equal(incident.snapshot().status, 'CLOSED');
  assert.equal(incident.sla.respondedAt.getTime(), at(3).getTime());
  assert.throws(() => incident.transition('ASSIGNED', at(8)), { status: 409 });
});

test('DOMAIN08 the user factory produces role classes with distinct visibility', () => {
  const document = {
    passwordHash: 'fixture-hash',
    authVersion: 2,
    googleSub: 'fixture-id',
    activeLoad: 1,
  };
  const employee = UserFactory.from({ ...document, role: 'EMPLOYEE', id: 'E101' });
  const technician = UserFactory.from({ ...document, role: 'TECHNICIAN', id: 'T201' });
  const admin = UserFactory.from({ ...document, role: 'ADMINISTRATOR', id: 'A301' });
  const incident = { reporter: 'E102', assignedTo: 'T201' };

  assert(employee instanceof Employee && employee instanceof User);
  assert(technician instanceof Technician && technician instanceof User);
  assert(admin instanceof Administrator && admin instanceof User);
  assert.deepEqual(
    [employee.canSee(incident), technician.canSee(incident), admin.canSee(incident)],
    [false, true, true],
  );
  assert.deepEqual(employee.publicProfile(), { role: 'EMPLOYEE', id: 'E101' });
});

test('DOMAIN09 SLA warnings and violations are emitted once at their boundaries', () => {
  const sla = newSla(gold, 'P1', start);
  assert.equal(slaStatus(sla, at(224), 0.75), 'ON_TRACK');
  assert.deepEqual(findings(sla, at(225), 0.75), ['RESPONSE_WARNING']);
  assert.equal(slaStatus(sla, at(225), 0.75), 'AT_RISK');
  assert.deepEqual(findings(sla, at(300), 0.75), []);
  assert.deepEqual(findings(sla, at(301), 0.75), ['RESPONSE_VIOLATION']);
  assert.deepEqual(findings(sla, at(1350), 0.75), ['RESOLUTION_WARNING']);
  assert.deepEqual(findings(sla, at(1800), 0.75), []);
  assert.deepEqual(findings(sla, at(1801), 0.75), ['RESOLUTION_VIOLATION']);
  assert.deepEqual(findings(sla, at(1802), 0.75), []);
});

test('DOMAIN10 only resolution time stops, even across multiple pauses', () => {
  const sla = newSla(gold, 'P1', start);
  sla.respondedAt = at(20);
  const responseDue = sla.responseDue;
  const initialResolution = Number(sla.resolutionDue);

  pauseResolution(sla, at(60));
  pauseResolution(sla, at(120));
  assert.deepEqual(findings(sla, at(3660), 0.75), []);
  assert.equal(slaStatus(sla, at(3660), 0.75), 'PAUSED');
  resumeResolution(sla, at(3660));
  pauseResolution(sla, at(3720));
  resumeResolution(sla, at(3780));

  assert.equal(sla.pausedAt, null);
  assert.equal(sla.responseDue, responseDue);
  assert.equal(sla.totalPausedMs, 3660000);
  assert.equal(Number(sla.resolutionDue), initialResolution + sla.totalPausedMs);
  assert.equal(slaStatus(sla, at(3780), 0.75), 'ON_TRACK');
});

test('DOMAIN11 a new observer participates through the shared event contract', async () => {
  class RecordingObserver extends EventObserver {
    constructor(name) {
      super();
      this.name = name;
    }

    async react(unit, event) {
      unit.push([this.name, event.action]);
    }
  }

  const unit = [];
  const bus = new EventBus([
    new RecordingObserver('audit'),
    new RecordingObserver('additional-channel'),
  ]);
  await bus.publish(unit, { action: 'CREATED' });
  assert.deepEqual(unit, [
    ['audit', 'CREATED'],
    ['additional-channel', 'CREATED'],
  ]);
});

test('DOMAIN12 channel adapters decide whether to receive workflow events', () => {
  const email = new EmailChannel(false),
    sms = new SmsChannel(),
    inApp = new InAppChannel();
  const acknowledgement = { action: 'ACKNOWLEDGED', incident: { priority: 'P2' } };
  const urgentAssignment = { action: 'ASSIGNED', incident: { priority: 'P1' } };
  assert.deepEqual(
    [email.supports(acknowledgement), sms.supports(acknowledgement), inApp.supports(acknowledgement)],
    [false, false, true],
  );
  assert.deepEqual(
    [email.supports(urgentAssignment), sms.supports(urgentAssignment), inApp.supports(urgentAssignment)],
    [true, true, true],
  );
});
