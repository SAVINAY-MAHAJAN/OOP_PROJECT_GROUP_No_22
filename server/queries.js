import { slaStates, defaultTimeZone } from '../shared/constants.js';
import {
  text,
  integer,
  choice,
  priorities,
  states,
  openStates,
  nowAt,
  requireThat,
} from './validation.js';
import { slaStatus } from './sla/clock.js';
import { accessIncident } from './incidents.js';
import { currentDay, shiftDay, startOfDay, localDay } from './dates.js';
import { dashboardRisk, detailRisk } from './sla/risk-service.js';

const escape = (s) => s.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&');
const contains = (s) => ({ $regex: escape(s), $options: 'i' });
const resolvedStates = ['RESOLVED', 'VERIFIED', 'CLOSED'];
const basicFields = {
  id: 1,
  title: 1,
  service: 1,
  status: 1,
  priority: 1,
  category: 1,
  assignedTo: 1,
  reporter: 1,
  createdAt: 1,
  version: 1,
  'sla.resolutionDue': 1,
  slaStatus: 1,
};
const sorting = {
  id: 'id',
  title: 'title',
  priority: 'priority',
  category: 'category',
  service: 'service',
  status: 'status',
  assignedTo: 'assignedTo',
  slaStatus: 'slaStatus',
  createdAt: 'createdAt',
};

export function slaExpression(now, warningFraction) {
  const responseNow = { $ifNull: ['$sla.stoppedAt', now] };
  const resolutionNow = { $ifNull: ['$sla.pausedAt', responseNow] };
  const noValue = (field) => ({ $eq: [{ $ifNull: ['$sla.' + field, null] }, null] });
  const noResponse = noValue('respondedAt');
  const noResolution = noValue('resolvedAt');
  const paused = { $ifNull: ['$sla.totalPausedMs', 0] };
  const seconds = (at, excluded) => ({
    $floor: { $divide: [{ $subtract: [{ $subtract: [at, '$sla.startedAt'] }, excluded] }, 1000] },
  });
  const risk = (phase, excluded) => ({
    $gte: [
      seconds(now, excluded),
      { $multiply: [warningFraction, seconds('$sla.' + phase + 'Due', excluded)] },
    ],
  });
  return {
    $switch: {
      branches: [
        { case: noValue('startedAt'), then: 'ON_TRACK' },
        {
          case: {
            $or: [
              '$sla.responseBreached',
              '$sla.resolutionBreached',
              { $and: [noResponse, { $gt: [responseNow, '$sla.responseDue'] }] },
              { $and: [noResolution, { $gt: [resolutionNow, '$sla.resolutionDue'] }] },
            ],
          },
          then: 'BREACHED',
        },
        { case: { $not: [noValue('stoppedAt')] }, then: 'STOPPED' },
        { case: { $not: [noResolution] }, then: 'MET' },
        { case: { $not: [noValue('pausedAt')] }, then: 'PAUSED' },
        {
          case: { $or: [{ $and: [noResponse, risk('response', 0)] }, risk('resolution', paused)] },
          then: 'AT_RISK',
        },
      ],
      default: 'ON_TRACK',
    },
  };
}

export function paging(query, size = 25) {
  const page = query.page ? integer(query.page, 'Page', 1, 100000) : 1;
  return { page, size, skip: (page - 1) * size };
}
export async function catalog(unit, user) {
  const services = await unit.services.find({}, { projection: { referenceRevision: 0 } });
  const categories = await unit.categories.find({}, { projection: { referenceRevision: 0 } });
  const result = { services, categories };
  if (user.role === 'ADMINISTRATOR') {
    result.policies = await unit.policies.find();
    result.technicians = await unit.users.find(
      { role: 'TECHNICIAN' },
      { projection: { id: 1, name: 1 } },
    );
    result.defaultPolicyId = unit.settings.defaultPolicyId;
  }
  return result;
}
async function nameRefs(unit, records) {
  const ids = [...new Set(records.flatMap((i) => [i.reporter, i.assignedTo]).filter(Boolean))];
  const serviceIds = [...new Set(records.map((i) => i.service))];
  const users = new Map(
    (await unit.users.find({ _id: { $in: ids } }, { projection: { id: 1, name: 1 } })).map((x) => [
      x.id,
      x.name,
    ]),
  );
  const services = new Map(
    (await unit.services.find({ _id: { $in: serviceIds } }, { projection: { id: 1, name: 1 } })).map(
      (x) => [x.id, x.name],
    ),
  );
  return records.map((i) => ({
    ...i,
    reporterName: users.get(i.reporter) ?? i.reporter,
    technicianName: i.assignedTo ? (users.get(i.assignedTo) ?? i.assignedTo) : null,
    serviceName: services.get(i.service) ?? i.service,
  }));
}

export async function incidentList(unit, user, q, timeZone = defaultTimeZone) {
  const { page, size, skip } = paging(q);
  const base = user.incidentScope(),
    filters = {};
  const queue = user.role === 'TECHNICIAN' && q.queue === 'assigned' ? { assignedTo: user.id } : {};
  if (q.id) filters.id = contains(text(q.id, 'ID', 1, 80));
  if (q.text) {
    const pattern = contains(text(q.text, 'Keyword', 1, 160));
    filters.$or = [{ title: pattern }, { description: pattern }];
  }
  if (q.priority) filters.priority = choice(q.priority, priorities, 'priority');
  if (q.status) filters.status = choice(q.status, states, 'status');
  for (const field of ['category', 'service', 'assignedTo', 'reporter'])
    if (q[field]) filters[field] = text(q[field], field, 1, 80);
  const from = q.from ? localDay(q.from) : null,
    to = q.to ? localDay(q.to) : null;
  requireThat(!from || !to || from <= to, 'From date must be on or before To date.');
  if (from || to)
    filters.createdAt = {
      ...(from ? { $gte: startOfDay(from, timeZone) } : {}),
      ...(to ? { $lt: startOfDay(shiftDay(to, 1), timeZone) } : {}),
    };
  const sort =
    typeof q.sort === 'string' && Object.hasOwn(sorting, q.sort)
      ? { [sorting[q.sort]]: q.dir === 'desc' ? -1 : 1, _id: 1 }
      : { priority: 1, createdAt: -1, _id: 1 };
  const [result] = await unit.incidents.aggregate([
    { $match: { $and: [base, filters, queue] } },
    { $set: { slaStatus: slaExpression(nowAt(unit.settings), unit.settings.slaWarningFraction) } },
    ...(q.sla ? [{ $match: { slaStatus: choice(q.sla, slaStates, 'SLA status') } }] : []),
    { $project: basicFields },
    {
      $facet: {
        rows: [{ $sort: sort }, { $skip: skip }, { $limit: size }],
        summary: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              open: { $sum: { $cond: [{ $in: ['$status', openStates] }, 1, 0] } },
              breached: { $sum: { $cond: [{ $eq: ['$slaStatus', 'BREACHED'] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ]);
  return {
    rows: await nameRefs(unit, result.rows),
    summary: result.summary[0] ?? { total: 0, open: 0, breached: 0 },
    page,
    size,
  };
}

export async function incidentDetail(unit, user, id) {
  const incident = await accessIncident(unit, user, id);
  const history = await unit.audit.find(
    { incidentId: id },
    { sort: { timestamp: 1, _id: 1 }, collation: { locale: 'en', numericOrdering: true } },
  );
  if (user.role !== 'ADMINISTRATOR' && incident.relatedIds.length) {
    const accessible = await unit.incidents.find(
      { $and: [{ _id: { $in: incident.relatedIds } }, user.incidentScope()] },
      { projection: { id: 1 } },
    );
    incident.relatedCount = incident.relatedIds.length;
    incident.relatedIds = accessible.map((other) => other.id);
    for (const row of history)
      if (row.action === 'DUPLICATE_SUSPECTED')
        row.description = 'Possibly related incident reports were found.';
  }
  delete incident.requestId;
  const [row] = await nameRefs(unit, [incident]);
  const now = nowAt(unit.settings);
  return {
    ...row,
    history,
    slaStatus: slaStatus(incident.sla, now, unit.settings.slaWarningFraction),
    slaRisk: await detailRisk(unit, incident, now),
  };
}

export async function dashboard(unit, timeZone = defaultTimeZone) {
  const now = nowAt(unit.settings),
    today = currentDay(now, timeZone);
  const days = Array.from({ length: 14 }, (_, index) => shiftDay(today, index - 13));
  const [summary] = await unit.incidents.aggregate([
    {
      $set: {
        isOpen: { $in: ['$status', openStates] },
        slaStatus: slaExpression(now, unit.settings.slaWarningFraction),
      },
    },
    {
      $facet: {
        overview: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              open: { $sum: { $cond: ['$isOpen', 1, 0] } },
              critical: { $sum: { $cond: [{ $and: ['$isOpen', { $eq: ['$priority', 'P1'] }] }, 1, 0] } },
              violations: { $sum: { $cond: [{ $eq: ['$slaStatus', 'BREACHED'] }, 1, 0] } },
              risk: {
                $sum: { $cond: [{ $and: ['$isOpen', { $eq: ['$slaStatus', 'AT_RISK'] }] }, 1, 0] },
              },
              averageFeedback: { $avg: '$feedback.rating' },
              resolutionMinutes: {
                $avg: {
                  $cond: [
                    { $ne: [{ $ifNull: ['$resolvedAt', null] }, null] },
                    { $floor: { $divide: [{ $subtract: ['$resolvedAt', '$createdAt'] }, 60000] } },
                    null,
                  ],
                },
              },
            },
          },
        ],
        byService: [{ $group: { _id: '$service', count: { $sum: 1 } } }],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
        urgent: [
          { $match: { isOpen: true, sla: { $ne: null } } },
          { $sort: { 'sla.resolutionDue': 1, _id: 1 } },
          { $limit: 8 },
          { $project: basicFields },
        ],
        outages: [
          { $match: { isOpen: true, createdAt: { $gte: new Date(+now - 3600000), $lte: now } } },
          {
            $group: {
              _id: '$service',
              count: { $sum: 1 },
              incidents: { $firstN: { input: '$id', n: 10 } },
            },
          },
          { $match: { count: { $gte: 3 } } },
          { $sort: { count: -1, _id: 1 } },
        ],
        volume: [
          { $match: { createdAt: { $gte: startOfDay(days[0], timeZone), $lte: now } } },
          {
            $group: {
              _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: timeZone } },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);
  const serviceNames = new Map((await unit.services.find()).map((item) => [item.id, item.name]));
  const counts = new Map(summary.byService.map((row) => [row._id, row.count]));
  const daily = new Map(summary.volume.map((row) => [row._id, row.count]));
  const techs = await unit.users.find(
    { role: 'TECHNICIAN' },
    { sort: { _id: 1 }, projection: { id: 1, name: 1, available: 1, maxConcurrent: 1, activeLoad: 1 } },
  );
  return {
    ...{
      total: 0,
      open: 0,
      critical: 0,
      violations: 0,
      risk: 0,
      averageFeedback: null,
      resolutionMinutes: null,
    },
    ...summary.overview[0],
    now,
    clockOffsetMinutes: unit.settings.clockOffsetMinutes,
    byService: [...serviceNames]
      .map(([id, label]) => ({ label, value: counts.get(id) || 0 }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
    byPriority: priorities.map((priority) => ({
      priority,
      value: summary.byPriority.find((row) => row._id === priority)?.count || 0,
    })),
    loads: techs.map(({ activeLoad, ...tech }) => ({ ...tech, load: activeLoad })),
    outages: summary.outages.map((row) => ({
      service: serviceNames.get(row._id),
      count: row.count,
      incidents: row.incidents,
    })),
    urgent: await nameRefs(unit, summary.urgent),
    volume: days.map((date) => ({ date, count: daily.get(date) || 0 })),
    ...(await dashboardRisk(unit, now, techs, serviceNames)),
  };
}

export async function technicianWorkload(unit, user) {
  const resolved = await unit.incidents.count({ assignedTo: user.id, status: { $in: resolvedStates } });
  return { user: user.publicProfile(), active: user.activeLoad, resolved };
}
export async function findingsList(unit, query) {
  const { page, size, skip } = paging(query);
  const [result] = await unit.incidents.aggregate([
    { $match: { 'sla.log.0': { $exists: true } } },
    { $unwind: '$sla.log' },
    {
      $project: {
        id: 1,
        service: 1,
        assignedTo: 1,
        priority: 1,
        status: 1,
        finding: '$sla.log.finding',
        at: '$sla.log.at',
      },
    },
    {
      $facet: {
        rows: [{ $sort: { at: -1, _id: 1, finding: 1 } }, { $skip: skip }, { $limit: size }],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  return { rows: await nameRefs(unit, result.rows), total: result.total[0]?.count || 0, page, size };
}

export async function outbox(unit, query) {
  const { page, size, skip } = paging(query);
  const channel = choice(
    text(query.channel || 'ALL', 'Channel', 1, 10).toUpperCase(),
    ['ALL', 'EMAIL', 'SMS'],
    'channel',
  );
  const source = channel === 'EMAIL' ? unit.emailOutbox : unit.smsOutbox;
  const sort = { createdAt: -1, _id: -1 };
  const records =
    channel === 'ALL'
      ? await unit.emailOutbox.aggregate([
          { $unionWith: 'smsOutbox' },
          { $sort: sort },
          { $skip: skip },
          { $limit: size },
        ])
      : await source.find({}, { sort, skip, limit: size });
  const unique = [...new Set(records.map((row) => row.recipientId).filter(Boolean))];
  const users = new Map(
    (await unit.users.find({ _id: { $in: unique } }, { projection: { id: 1, name: 1 } })).map((user) => [
      user.id,
      user.name,
    ]),
  );
  const rows = records.map((row) => ({
    ...row,
    state: row.state || 'SIMULATED',
    ...(row.channel === 'SMS'
      ? { recipientName: row.recipientName || users.get(row.recipientId) || row.recipientId }
      : {}),
  }));
  const total =
    channel === 'ALL'
      ? (await unit.emailOutbox.count()) + (await unit.smsOutbox.count())
      : await source.count();
  return { rows, total, page, size };
}

function csvCell(data) {
  const value = data instanceof Date ? data.toISOString() : String(data ?? '');
  const neutral = /^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + neutral.replaceAll('"', '""') + '"';
}

/** Stream rows so a report does not load the whole collection into the API process. */
export async function* incidentCsv(unit) {
  yield 'Incident ID,Title,Service,Category,Priority,Status,Assigned To,Created,Response Due,Resolution Due\r\n';
  const services = new Map(
    (await unit.services.find({}, { projection: { id: 1, name: 1 } })).map((x) => [x.id, x.name]),
  );
  const cursor = unit.incidents.scan({}, { sort: { createdAt: -1, _id: 1 } });
  try {
    for await (const i of cursor) {
      yield (
        [
          i.id,
          i.title,
          services.get(i.service) || i.service,
          i.category,
          i.priority,
          i.status,
          i.assignedTo,
          i.createdAt,
          i.sla?.responseDue,
          i.sla?.resolutionDue,
        ]
          .map(csvCell)
          .join(',') + '\r\n'
      );
    }
  } finally {
    await cursor.close();
  }
}
