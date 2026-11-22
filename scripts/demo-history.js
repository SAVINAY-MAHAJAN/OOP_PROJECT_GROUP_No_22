import { connectDatabase } from '../server/database.js';
import { readAppConfig } from '../server/config.js';
import { Incident } from '../server/domain/incident.js';
import { newSla } from '../server/sla/clock.js';
import { policyFor } from '../server/sla/policy.js';
import { integer, requireThat, nowAt } from '../server/validation.js';

const minute = 60000;
const cases = [
  ['SVC1', 'P1', [18, 24, 38, 42, 52, 63, 70, 78, 91, 102]],
  ['SVC4', 'P2', [35, 45, 70, 95, 130, 160, 180, 210, 275, 320]],
  ['SVC5', 'P2', [45, 55, 75, 90, 110, 160, 185, 235, 275, 290]],
];

async function addHistory(repo) {
  const unit = await repo.read();
  const reporter =
    (await unit.users.one({ email: 'ravi@nexora.com', active: true })) ||
    (await unit.users.one({ role: 'EMPLOYEE', active: true }));
  requireThat(reporter, 'An active demo employee is needed for the sample history.');
  const time = nowAt(unit.settings);
  let added = 0;
  for (const [serviceId, priority, durations] of cases) {
    for (const [offset, duration] of durations.entries()) {
      const requestId = 'demo-sla-history-v1-' + serviceId + '-' + offset;
      if (await unit.incidents.one({ sampleTag: requestId })) continue;
      try {
        const inserted = await repo.change(async (work) => {
          if (await work.incidents.one({ sampleTag: requestId })) return false;
          const service = await work.services.get(serviceId);
          const policy = await policyFor(work, service);
          const id = await work.counters.next('INC');
          const start = new Date(+time - (3 * 24 * 60 + 60 * offset) * minute);
          const resolvedAt = new Date(+start + duration * minute);
          const closedAt = new Date(+resolvedAt + 5 * minute);
          const sla = newSla(policy, priority, start);
          sla.respondedAt = new Date(+start + 2 * minute);
          sla.resolvedAt = resolvedAt;
          const responseBreached = sla.respondedAt > sla.responseDue;
          const resolutionBreached = resolvedAt > sla.resolutionDue;
          Object.assign(sla, { responseBreached, resolutionBreached });
          const incident = Incident.draft({
            _id: id,
            id,
            reporter: reporter.id,
            service: service.id,
            category: service.defaultCategory,
            impact: 'HIGH',
            urgency: 'HIGH',
            businessCriticality: service.criticality,
            affectedUsers: 50,
            requestId,
            sampleTag: requestId,
            title: 'Demo history · ' + service.name + ' ' + priority + ' (' + (offset + 1) + ')',
            description: 'Synthetic historical incident for the resolution breach forecast.',
            status: 'CLOSED',
            priority,
            createdAt: start,
            updatedAt: closedAt,
            sla,
            resolution: 'Demo case completed.',
            resolvedBy: 'Demo history',
            resolvedAt,
            closedAt,
            closedBy: 'Demo history',
          });
          await work.services.update({ _id: service.id }, { $inc: { referenceRevision: 1 } });
          if (service.defaultCategory)
            await work.categories.update(
              { _id: service.defaultCategory },
              { $inc: { referenceRevision: 1 } },
            );
          await work.incidents.insert(incident.snapshot());
          return true;
        });
        if (inserted) added++;
      } catch (error) {
        if (error.code !== 11000 || !(await unit.incidents.one({ sampleTag: requestId }))) throw error;
      }
    }
  }
  return added;
}

try {
  const config = readAppConfig();
  requireThat(config.demoMode, 'Synthetic history can be added only in demo mode.');
  const port = integer(process.env.MONGO_PORT || 27271, 'MongoDB port', 1024, 65535);
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:' + port + '/?replicaSet=nexora';
  const repo = await connectDatabase(uri, process.env.MONGODB_DB || 'nexora_servicedesk', {
    demoMode: true,
  });
  try {
    console.log('Added ' + (await addHistory(repo)) + ' synthetic closed cases.');
  } finally {
    await repo.close();
  }
} catch (error) {
  console.error(
    'Unable to add demo history. ' +
      (error.name === 'MongoServerSelectionError'
        ? 'Start the demo application or set its MONGODB_URI first.'
        : error.message),
  );
  process.exitCode = 1;
}
