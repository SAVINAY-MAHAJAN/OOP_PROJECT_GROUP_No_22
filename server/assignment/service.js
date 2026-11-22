import { requireThat } from '../validation.js';
import { rankTechnicians } from './strategies.js';
import { recordEvent } from '../events.js';

export async function recommendations(unit, incident) {
  const technicians = await unit.users.find(
    { role: 'TECHNICIAN', active: true, available: true },
    {
      projection: {
        id: 1,
        name: 1,
        role: 1,
        skills: 1,
        experienceYears: 1,
        active: 1,
        available: 1,
        activeLoad: 1,
        maxConcurrent: 1,
      },
    },
  );
  const records = await unit.incidents.find(
    {
      service: incident.service,
      assignedTo: { $in: technicians.map((tech) => tech.id) },
      status: { $in: ['RESOLVED', 'VERIFIED', 'CLOSED'] },
    },
    { projection: { assignedTo: 1, service: 1, status: 1 } },
  );
  return {
    ranking: rankTechnicians(incident, technicians, records, unit.settings),
    strategy: unit.settings.assignmentStrategyKey,
    reason: technicians.length
      ? 'All available technicians are at maximum workload.'
      : 'No technician is currently available.',
  };
}

export async function assignIncident(unit, incident, actor, chosen, now) {
  const previous = incident.status;
  requireThat(
    ['CLASSIFIED', 'ASSIGNED'].includes(previous),
    'Only a classified or assigned incident can be reassigned.',
    409,
  );
  const { ranking, reason, strategy } = await recommendations(unit, incident);
  const candidates = chosen ? ranking.filter((candidate) => candidate.id === chosen) : ranking;
  const current = incident.assignedTo;
  for (const candidate of candidates) {
    if (candidate.id !== current) {
      if (!(await unit.users.reserve(candidate.id))) continue;
      await unit.users.changeLoad(current, -1);
    }
    incident.assign(candidate.id, now);
    if (strategy === 'ROUND_ROBIN')
      await unit.settingsRepository.update(
        { _id: 'global' },
        { $set: { lastAssignedId: candidate.id } },
      );
    await recordEvent(
      unit,
      incident,
      actor,
      'ASSIGNED',
      previous,
      'Assigned to ' +
        candidate.name +
        ' (' +
        candidate.id +
        ') · ' +
        (actor ? 'manual' : strategy) +
        ' · ' +
        candidate.reason,
      now,
      current,
    );
    return;
  }
  if (actor)
    requireThat(false, chosen ? 'The technician is unavailable or at maximum workload.' : reason, 409);
  await recordEvent(
    unit,
    incident,
    null,
    'ASSIGNMENT_FAILED',
    previous,
    reason + ' Manual assignment required.',
    now,
  );
}
