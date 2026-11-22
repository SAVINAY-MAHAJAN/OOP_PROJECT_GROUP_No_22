import { levels } from '../../shared/constants.js';

/** Implementations accept the same classification inputs and return a decision with its rationale. */
export class PriorityStrategy {
  /** Return a priority and human-readable rationale. */
  evaluate() {
    throw new Error('PriorityStrategy requires an evaluate implementation.');
  }
}

const weights = (impact) => levels.indexOf(impact) + 1;
/** Uses the weighted impact, urgency, service and user-count formula. */
export class WeightedPriority extends PriorityStrategy {
  /** @inheritdoc */
  evaluate(incident) {
    const { impact, urgency, businessCriticality, affectedUsers } = incident;
    const factors = [impact, urgency, businessCriticality].map(weights);
    const multiplier =
      affectedUsers >= 200 ? 2 : affectedUsers >= 50 ? 1.5 : affectedUsers >= 10 ? 1.25 : 1;
    const score = factors.reduce((total, value) => total * value, multiplier);
    const priority = [
      [36, 'P1'],
      [18, 'P2'],
      [6, 'P3'],
      [0, 'P4'],
    ].find(([limit]) => score >= limit)[1];
    return { priority, score, reason: [...factors, multiplier].join(' × ') + ' = ' + score };
  }
}
/** Evaluates the ordered business rules and keeps the first match. */
export class RulePriority extends PriorityStrategy {
  /** @inheritdoc */
  evaluate(incident) {
    const [impact, urgency, criticality] = [
      incident.impact,
      incident.urgency,
      incident.businessCriticality,
    ].map(weights);
    const rules = [
      [criticality === 4 && impact === 4, 'P1', 'Critical service fully impacted'],
      [
        incident.category?.toLowerCase() === 'security' && impact >= 3,
        'P1',
        'Security incident with high impact',
      ],
      [incident.affectedUsers >= 200 && urgency >= 3, 'P1', '200+ users with high urgency'],
      [impact >= 3 && urgency >= 3, 'P2', 'High impact and high urgency'],
      [criticality >= 3 && impact >= 2, 'P2', 'Important service with at least medium impact'],
      [impact >= 2 || urgency >= 2, 'P3', 'Medium impact or urgency'],
    ];
    const [, priority, reason] = rules.find(([matches]) => matches) || [
      true,
      'P4',
      'Default low priority',
    ];
    return { priority, reason };
  }
}
const strategies = new Map([
  ['WEIGHTED', new WeightedPriority()],
  ['RULES', new RulePriority()],
]);
export const prioritize = (incident, key) => strategies.get(key).evaluate(incident);
