import { isOpen } from '../validation.js';
import { defaultRiskThreshold, openStates } from '../../shared/constants.js';
import { SlaRiskPredictor } from './predictor.js';

const predictor = new SlaRiskPredictor();

export function riskThreshold(settings) {
  return settings.riskThresholdPercent ?? defaultRiskThreshold;
}

/** A response breach can coexist with a resolution target that is still actionable. */
export function eligibleForRisk(incident, now) {
  const { sla } = incident;
  return Boolean(
    sla &&
    isOpen(incident) &&
    !sla.resolvedAt &&
    !sla.stoppedAt &&
    !sla.resolutionBreached &&
    (sla.pausedAt || now) <= sla.resolutionDue,
  );
}

/** Load the latest 500 completed records once for a dashboard, detail fetch, or whole monitor pass. */
export function loadRiskHistory(unit, now) {
  return unit.incidents.find(
    {
      status: 'CLOSED',
      closedAt: { $lte: now },
      'sla.resolvedAt': { $type: 'date' },
    },
    {
      sort: { closedAt: -1, _id: 1 },
      limit: 500,
      projection: {
        id: 1,
        service: 1,
        priority: 1,
        'sla.startedAt': 1,
        'sla.resolvedAt': 1,
        'sla.totalPausedMs': 1,
      },
    },
  );
}

/** Compute the same forecast for details, dashboard, and alerting. */
export function predictRisk(incident, history, now, assignee, serviceName) {
  return predictor.predict(incident, { history, now, assignee, serviceName });
}

export async function detailRisk(unit, incident, now) {
  if (!eligibleForRisk(incident, now)) return null;
  const [history, assignee, service] = await Promise.all([
    loadRiskHistory(unit, now),
    incident.assignedTo
      ? unit.users.one({ _id: incident.assignedTo }, { projection: { activeLoad: 1, maxConcurrent: 1 } })
      : null,
    unit.services.one({ _id: incident.service }, { projection: { name: 1 } }),
  ]);
  return predictRisk(incident, history, now, assignee, service?.name);
}

/** Count all predicted risks while retaining a bounded shortlist. */
export async function dashboardRisk(unit, now, technicians, serviceNames) {
  const history = await loadRiskHistory(unit, now);
  const assignees = new Map(technicians.map((tech) => [tech.id, tech]));
  const threshold = riskThreshold(unit.settings);
  const queue = [];
  let count = 0;
  const cursor = unit.incidents.scan(
    { status: { $in: openStates }, sla: { $ne: null } },
    {
      projection: {
        id: 1,
        title: 1,
        service: 1,
        priority: 1,
        status: 1,
        assignedTo: 1,
        sla: 1,
        escalationLevel: 1,
      },
    },
  );
  try {
    for await (const incident of cursor) {
      if (!eligibleForRisk(incident, now)) continue;
      const serviceName = serviceNames.get(incident.service);
      const technician = assignees.get(incident.assignedTo);
      const slaRisk = predictRisk(incident, history, now, technician, serviceName);
      if (slaRisk.probability * 100 + 1e-9 < threshold) continue;
      count++;
      queue.push({
        id: incident.id,
        title: incident.title,
        priority: incident.priority,
        serviceName,
        technicianName: technician?.name || null,
        slaRisk,
      });
      queue.sort((a, b) => b.slaRisk.probability - a.slaRisk.probability || a.id.localeCompare(b.id));
      if (queue.length > 8) queue.pop();
    }
  } finally {
    await cursor.close();
  }
  return { predictedToBreach: count, predictedQueue: queue, riskThresholdPercent: threshold };
}
