import { escalationChain, openStates } from '../../shared/constants.js';
import { isOpen, nowAt } from '../validation.js';
import { findings } from './clock.js';
import { recordEvent } from '../events.js';
import { loadRiskHistory, eligibleForRisk, predictRisk, riskThreshold } from './risk-service.js';

export async function checkSla(unit, incident, now) {
  if (!incident.sla || !isOpen(incident)) return [];
  const notices = [];
  for (const finding of findings(incident.sla, now, unit.settings.slaWarningFraction)) {
    const isBreach = finding.endsWith('VIOLATION');
    const deadline = incident.sla[finding.startsWith('RESPONSE') ? 'responseDue' : 'resolutionDue'];
    const phase = finding.startsWith('RESPONSE') ? 'response' : 'resolution';
    const description =
      (isBreach ? 'SLA violation: ' : 'SLA warning: ') +
      phase +
      ' deadline ' +
      deadline.toISOString() +
      (isBreach ? ' missed.' : ' is approaching.');
    await recordEvent(
      unit,
      incident,
      null,
      isBreach ? 'SLA_VIOLATED' : 'SLA_WARNING',
      incident.status,
      description,
      now,
    );
    notices.push(incident.id + ' · ' + description);
  }
  return notices;
}

async function escalate(unit, incident, now) {
  const overdue = now - incident.sla.responseDue;
  if (incident.sla.respondedAt || !['P1', 'P2'].includes(incident.priority) || overdue < 0) return null;
  const level = Math.min(3, 1 + Math.floor(overdue / (unit.settings.escalationStepMinutes * 60000)));
  if (level <= incident.escalationLevel) return null;
  const admins = await unit.users.find(
    { role: 'ADMINISTRATOR', active: true },
    { projection: { id: 1, name: 1, title: 1 } },
  );
  let target =
    level === 1
      ? await unit.users.one({
          role: 'TECHNICIAN',
          teamLead: true,
          active: true,
          _id: { $ne: incident.assignedTo },
        })
      : null;
  target ||=
    admins.find(
      (admin) => admin.title?.toLowerCase() === escalationChain[Math.max(level, 2)].toLowerCase(),
    ) || admins[0];
  incident.escalationLevel = level;
  const description =
    'Unacknowledged ' +
    incident.priority +
    ' escalated to ' +
    escalationChain[level] +
    (target ? ' (' + target.name + ')' : '') +
    '.';
  await recordEvent(unit, incident, null, 'ESCALATED', incident.status, description, now, target?.id);
  return incident.id + ' · ' + description;
}

/** Warnings and escalation for each ticket are committed together and may retry independently. */
export async function monitor(repo) {
  const unit = await repo.read(),
    notices = [];
  const history = await loadRiskHistory(unit, nowAt(unit.settings));
  const candidates = await unit.incidents.find(
    { status: { $in: openStates }, sla: { $ne: null } },
    { projection: { _id: 1 } },
  );
  for (const { _id } of candidates) {
    const messages = await repo.change(async (work) => {
      const record = await work.incidents.one({ _id, status: { $in: openStates }, sla: { $ne: null } });
      if (!record) return [];
      const at = nowAt(work.settings);
      const findings = await checkSla(work, record, at);
      const escalation = await escalate(work, record, at);
      if (escalation) findings.push(escalation);
      if (!record.sla.riskNotified && eligibleForRisk(record, at)) {
        const assignee = record.assignedTo
          ? await work.users.one(
              { _id: record.assignedTo },
              { projection: { activeLoad: 1, maxConcurrent: 1 } },
            )
          : null;
        const service = await work.services.one({ _id: record.service }, { projection: { name: 1 } });
        const risk = predictRisk(record, history, at, assignee, service?.name);
        if (risk.probability * 100 + 1e-9 >= riskThreshold(work.settings)) {
          record.sla.riskNotified = true;
          const message =
            'Predicted ' +
            Math.round(risk.probability * 100) +
            '% resolution breach risk. ' +
            risk.factors.join(' ');
          await recordEvent(work, record, null, 'SLA_RISK_PREDICTED', record.status, message, at);
          findings.push(record.id + ' · ' + message);
        }
      }
      if (findings.length)
        await work.incidents.update(
          { _id },
          { $set: { sla: record.sla, escalationLevel: record.escalationLevel } },
        );
      return findings;
    });
    notices.push(...messages);
  }
  return notices;
}
