import test from 'node:test';
import assert from 'node:assert/strict';
import { SlaRiskPredictor } from '../server/sla/predictor.js';

const predictor = new SlaRiskPredictor();
const minute = 60000,
  start = new Date('2026-01-01T12:00:00Z');
const at = (minutes) => new Date(+start + minute * minutes);
const ticket = (overrides = {}) => ({
  id: 'test-ticket',
  service: 'SVC1',
  priority: 'P1',
  status: 'IN_PROGRESS',
  escalationLevel: 0,
  sla: {
    startedAt: start,
    responseDue: at(10),
    resolutionDue: at(30),
    respondedAt: at(2),
    totalPausedMs: 0,
  },
  ...overrides,
});
const history = (durations, service = 'SVC1', priority = 'P1') =>
  durations.map((duration, index) => ({
    id: 'closed-' + service + '-' + index,
    service,
    priority,
    status: 'CLOSED',
    sla: { startedAt: start, resolvedAt: at(duration), totalPausedMs: 0 },
  }));

test('RISK01 same-service and priority history determines an explainable high forecast', () => {
  const comparisons = history([15, 32, 36, 41, 45, 59]);
  const risk = predictor.predict(ticket(), {
    now: at(3),
    history: comparisons,
    serviceName: 'Payment Gateway',
  });
  assert.equal(risk.probability, 5 / 6);
  assert.equal(risk.level, 'HIGH');
  assert(risk.factors.some((text) => text.includes('Payment Gateway') && text.includes('5 of 6')));
});

test('RISK02 sparse and absent histories use the documented prior', () => {
  const noHistory = predictor.predict(ticket(), { now: at(3) });
  assert.equal(noHistory.probability, 0.25);
  assert.equal(noHistory.level, 'LOW');
  const wrongPriority = history([35, 36, 37, 38, 39], 'SVC1', 'P2');
  assert.deepEqual(
    predictor.predict(ticket(), { now: at(3), history: [...history([6, 7]), ...wrongPriority] }),
    noHistory,
  );
});

test('RISK03 a small service cohort falls back to the same priority across services', () => {
  const comparisons = [...history([8, 35]), ...history([10, 40, 55], 'SVC2')];
  const result = predictor.predict(ticket(), { now: at(2), history: comparisons });
  assert.equal(result.probability, 0.6);
  assert.equal(result.level, 'MEDIUM');
  assert.match(result.factors[0], /across services/);
});

test('RISK04 elapsed conditioning removes resolved comparisons and honors a running pause', () => {
  const comparisons = history([4, 13, 25, 32, 36]);
  assert.equal(predictor.predict(ticket(), { now: at(2), history: comparisons }).probability, 0.4);
  assert.equal(predictor.predict(ticket(), { now: at(20), history: comparisons }).probability, 2 / 3);
  const i = ticket({ status: 'PENDING_INFO' });
  i.sla.pausedAt = at(20);
  assert.equal(predictor.predict(i, { now: at(200), history: comparisons }).probability, 2 / 3 + 0.1);
  assert.equal(predictor.predict(ticket(), { now: at(60), history: comparisons }).probability, 0.4);
});

test('RISK05 workload, response, waiting, and escalation adjustments clamp at one', () => {
  const i = ticket({ escalationLevel: 2, status: 'PENDING_INFO' });
  i.sla.respondedAt = null;
  const inputs = {
    now: at(9),
    history: history([33, 34, 35, 36, 40]),
    assignee: { activeLoad: 4, maxConcurrent: 5 },
  };
  const result = predictor.predict(i, inputs);
  assert.equal(result.probability, 1);
  assert.equal(result.factors.filter((text) => text.includes('percentage points')).length, 4);
  assert.deepEqual(predictor.predict(i, inputs), result);
  assert.equal(i.sla.respondedAt, null);
  assert.equal(inputs.history.length, 5);
});
