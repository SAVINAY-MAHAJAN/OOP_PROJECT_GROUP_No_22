import { isOpen } from '../validation.js';

/** A strategy ranks eligible technicians and provides an explanation for each candidate. */
export class AssignmentStrategy {
  /** Score a technician against the incident and their current assignment context. */
  score() {
    throw new Error('AssignmentStrategy requires a score implementation.');
  }

  /** Return eligible candidates ordered by their score and stable tie-breaker. */
  rank(teams, incident) {
    return teams
      .map(({ technician, load, history }) => {
        const skill = technician.skills.some(
          (name) => name.toLowerCase() === incident.category?.toLowerCase(),
        );
        const { id, name, experienceYears, maxConcurrent } = technician;
        const score = this.score(technician, incident, { load, history, skill });
        const reason =
          (skill ? 'Skill match' : 'No skill match') +
          ', load ' +
          load +
          '/' +
          maxConcurrent +
          ', ' +
          experienceYears +
          ' years, ' +
          history +
          ' past fixes on service';
        return { id, name, score, reason };
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
/** Weights category skills, free capacity, experience and service history. */
export class SkillBased extends AssignmentStrategy {
  /** @inheritdoc */
  score(technician, incident, { load, history, skill }) {
    return (
      Number(skill) * 50 +
      30 * (1 - load / technician.maxConcurrent) +
      Math.min(10, technician.experienceYears) +
      2 * Math.min(history, 5)
    );
  }
}
/** Prioritizes the least loaded eligible technician. */
export class LoadBased extends AssignmentStrategy {
  /** @inheritdoc */
  score(technician, incident, { load }) {
    return -100 * load + technician.experienceYears;
  }
}
/** Prioritizes seniority for urgent work and existing service experience. */
export class ExperienceBased extends AssignmentStrategy {
  /** @inheritdoc */
  score(technician, incident, { load, history, skill }) {
    const experience = Math.min(10, technician.experienceYears);
    const seniority = ['P1', 'P2'].includes(incident.priority) ? experience : 10 - experience;
    return seniority * 3 + Number(skill) * 20 + history * 3 - load * 2;
  }
}
/** Rotates through eligible technicians after the previous assignee. */
export class RoundRobin extends AssignmentStrategy {
  /** @inheritdoc */
  rank(teams, incident, settings) {
    const ordered = teams.map((team) => team.technician).sort((a, b) => a.id.localeCompare(b.id));
    let turn = ordered.findIndex((tech) => tech.id > (settings.lastAssignedId || ''));
    if (turn < 0) turn = 0;
    return [...ordered.slice(turn), ...ordered.slice(0, turn)].map(({ id, name }, index) => ({
      id,
      name,
      score: ordered.length - index,
      reason: 'Turn ' + (index + 1) + ' in technician ID order',
    }));
  }
}
const strategies = new Map([
  ['SKILL', new SkillBased()],
  ['LOAD', new LoadBased()],
  ['EXPERIENCE', new ExperienceBased()],
  ['ROUND_ROBIN', new RoundRobin()],
]);

export function rankTechnicians(incident, technicians, incidents, settings) {
  const loads = new Map(),
    history = new Map();
  for (const previous of incidents) {
    const id = previous.assignedTo;
    if (isOpen(previous)) loads.set(id, (loads.get(id) || 0) + 1);
    else if (previous.status !== 'CANCELLED' && incident.service === previous.service)
      history.set(id, (history.get(id) || 0) + 1);
  }
  const teams = technicians
    .filter((t) => t.active && t.available)
    .map((technician) => ({
      technician,
      load: technician.activeLoad ?? loads.get(technician.id) ?? 0,
      history: history.get(technician.id) || 0,
    }))
    .filter(
      ({ load, technician }) => load < technician.maxConcurrent || technician.id === incident.assignedTo,
    );
  return strategies.get(settings.assignmentStrategyKey).rank(teams, incident, settings);
}
