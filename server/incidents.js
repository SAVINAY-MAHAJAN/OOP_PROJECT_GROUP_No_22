import { choice, levels, requireThat, text, integer, role, nowAt, openStates } from './validation.js';
import { prioritize } from './priority/strategies.js';
import { categorize, similar } from './nlp/text.js';
import { assignIncident } from './assignment/service.js';
import { newSla } from './sla/clock.js';
import { policyFor } from './sla/policy.js';
import { recordEvent } from './events.js';
import { Incident } from './domain/incident.js';
import { commands } from './domain/actions.js';

const open = { status: { $in: openStates } };

export async function suggestCategory(unit, input) {
  const service = await unit.services.get(text(input.service, 'Affected service', 1, 80));
  return categorize(
    text(input.title, 'Title', 0, 120),
    text(input.description, 'Description'),
    await unit.categories.find(),
    service,
  );
}

export async function report(unit, user, input) {
  role(user, 'EMPLOYEE', 'TECHNICIAN', 'ADMINISTRATOR');
  const requestId = text(input.requestId, 'Request ID', 1, 80);
  const already = await unit.incidents.one({ reporter: user.id, requestId });
  if (already) return already;
  const title = text(input.title, 'Title', 5, 120);
  const description = text(input.description, 'Description', 10, 2000);
  const service = await unit.services.get(text(input.service, 'Affected service', 1, 80));
  const category = input.category
    ? (await unit.categories.get(text(input.category, 'Category', 1, 40))).id
    : categorize(title, description, await unit.categories.find(), service);
  requireThat(category, 'Could not determine a category. Please choose one.');
  const now = nowAt(unit.settings);
  const incident = Incident.draft({
    title,
    description,
    reporter: user.id,
    service: service.id,
    requestId,
    category,
    impact: choice(input.impact, levels, 'impact'),
    urgency: choice(input.urgency, levels, 'urgency'),
    businessCriticality: service.criticality,
    affectedUsers: integer(input.affectedUsers, 'Users affected', 1, 100000),
    createdAt: now,
    updatedAt: now,
  });

  // Coordinate reports for this service with concurrent correlation and catalog deletion.
  await unit.services.update({ _id: service.id }, { $inc: { referenceRevision: 1 } });
  await unit.categories.update({ _id: category }, { $inc: { referenceRevision: 1 } });
  const candidates = await unit.incidents.find(
    { $or: [open, { createdAt: { $gte: new Date(+now - 86400000) } }] },
    {
      projection: {
        id: 1,
        title: 1,
        description: 1,
        service: 1,
        category: 1,
        status: 1,
        reporter: 1,
        assignedTo: 1,
      },
    },
  );
  const related = similar(incident, candidates, 0.45, 5);
  requireThat(
    input.force === true || !related.some((r) => r.score >= 0.85),
    'This looks like an incident that is already reported.',
    409,
    {
      code: 'DUPLICATE',
      candidates: related.map(({ item, score }) =>
        user.canSee(item)
          ? { id: item.id, title: item.title, score }
          : { title: 'Another incident on this service', score },
      ),
    },
  );
  const decision = prioritize(incident, unit.settings.priorityStrategyKey);
  const sla = newSla(await policyFor(unit, service), decision.priority, now);
  const id = await unit.counters.next('INC');
  Object.assign(incident, { _id: id, id });
  await recordEvent(
    unit,
    incident,
    user,
    'CREATED',
    null,
    'Incident ' + id + ' created by ' + user.name + ': ' + title,
    now,
  );
  incident.classify(decision.priority, sla, now);
  await recordEvent(
    unit,
    incident,
    null,
    'CLASSIFIED',
    'NEW',
    'Incident classified as ' + category,
    now,
  );
  await recordEvent(
    unit,
    incident,
    null,
    'PRIORITY_CALCULATED',
    'CLASSIFIED',
    'Priority calculated as ' +
      incident.priority +
      ' (' +
      decision.reason +
      '). Applied ' +
      sla.policyName +
      ' SLA.',
    now,
  );
  if (related.length) {
    incident.relatedIds = related.map(({ item }) => item.id);
    await unit.incidents.linkRelated(incident.relatedIds, id);
    if (unit.live.count())
      for (const relatedId of incident.relatedIds) {
        unit.afterCommit(() => unit.live.incidentChanged(relatedId), 'incident:' + relatedId);
      }
    await recordEvent(
      unit,
      incident,
      null,
      'DUPLICATE_SUSPECTED',
      incident.status,
      'Possibly related to ' + incident.relatedIds.join(', '),
      now,
    );
  }
  await assignIncident(unit, incident, null, null, now);
  await unit.incidents.insert(incident.snapshot());
  const cluster = await unit.incidents.count({
    ...open,
    service: incident.service,
    createdAt: { $gte: new Date(+now - 3600000), $lte: now },
  });
  if (cluster >= 3)
    await recordEvent(
      unit,
      incident,
      null,
      'OUTAGE_SUSPECTED',
      incident.status,
      cluster + ' open incidents on ' + service.name + ' within one hour: probable outage.',
      now,
    );
  return incident;
}

export async function accessIncident(unit, user, id) {
  const incident = await unit.incidents.get(id);
  requireThat(user.canSee(incident), 'Incident could not be found.', 404);
  return incident;
}

export async function resolutions(unit, user, id) {
  const incident = await accessIncident(unit, user, id);
  role(user, 'TECHNICIAN');
  requireThat(
    incident.assignedTo === user.id,
    'Only the assigned technician can request suggestions.',
    403,
  );
  const past = await unit.incidents.find(
    { ...user.incidentScope(), resolution: { $type: 'string' } },
    { projection: { id: 1, title: 1, description: 1, service: 1, category: 1, resolution: 1 } },
  );
  return similar(incident, past, 0.35, 3).map(({ item, score }) => ({
    id: item.id,
    title: item.title,
    resolution: item.resolution,
    score,
  }));
}

export async function act(unit, user, id, action, input) {
  const incident = new Incident(await accessIncident(unit, user, id));
  const { status: previous, version } = incident;
  if (input.version != null)
    requireThat(
      input.version === version,
      'This incident changed. Refresh its details and try again.',
      409,
    );
  const command = commands.get(action);
  requireThat(command, 'Unknown incident action.', 404);
  const at = nowAt(unit.settings);
  const event = (type, message, from = previous, extra = null) =>
    recordEvent(unit, incident, user, type, from, message, at, extra);
  await command.execute({ unit, user, incident, at, event }, input);
  incident.updatedAt = at;
  incident.version = version + 1;
  await unit.incidents.saveWorkflow(incident, version);
  return incident;
}
