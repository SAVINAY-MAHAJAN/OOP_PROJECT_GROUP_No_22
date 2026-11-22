const minuteMs = 60000;
const minimumSample = 5;
const prior = 0.25;

/** Closed cases provide active work durations. Pending-customer time is excluded. */
function durationOf(record) {
  const start = record.sla?.startedAt || record.createdAt;
  const end = record.sla?.resolvedAt || record.resolvedAt;
  if (!start || !end) return null;
  const duration = +new Date(end) - +new Date(start) - (record.sla?.totalPausedMs || 0);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/** An explainable, deterministic estimate of missing a resolution target. */
export class SlaRiskPredictor {
  /**
   * Estimate P(duration > target | duration > active elapsed) on comparable closed incidents.
   * Use the base rate if no comparison survived to the current age, or a 25% prior for sparse history.
   */
  predict(incident, { now, history = [], assignee = null, serviceName = incident.service } = {}) {
    const { sla, priority, service, status, escalationLevel } = incident;
    if (!sla)
      return {
        probability: prior,
        level: 'LOW',
        factors: ['No resolution target. Used the 25% prior.'],
      };
    const paused = sla.totalPausedMs || 0;
    const target = +new Date(sla.resolutionDue) - +new Date(sla.startedAt) - paused;
    const elapsed = Math.max(0, +new Date(sla.pausedAt || now) - +new Date(sla.startedAt) - paused);
    const comparable = history
      .filter((record) => record.priority === priority && record.id !== incident.id)
      .map((record) => ({ service: record.service, duration: durationOf(record) }))
      .filter((row) => row.duration !== null);
    const sameService = comparable.filter((row) => row.service === service);
    const sample = sameService.length >= minimumSample ? sameService : comparable;
    let probability = prior;
    const factors = [];

    if (sample.length >= minimumSample) {
      const misses = sample.filter((row) => row.duration > target).length;
      probability = misses / sample.length;
      const scope = sameService.length >= minimumSample ? ' on ' + serviceName : ' across services';
      factors.push(
        'Similar ' +
          priority +
          ' incidents' +
          scope +
          ' exceeded this target in ' +
          misses +
          ' of ' +
          sample.length +
          ' cases.',
      );
      const survivors = sample.filter((row) => row.duration > elapsed);
      if (survivors.length) {
        const laterMisses = survivors.filter((row) => row.duration > target).length;
        probability = laterMisses / survivors.length;
        factors.push(
          'At ' +
            Math.floor(elapsed / minuteMs) +
            ' active minutes, ' +
            laterMisses +
            ' of ' +
            survivors.length +
            ' still-open comparisons exceeded the target.',
        );
      } else factors.push('No comparable case lasted this long. Used the base rate.');
    } else factors.push('Fewer than five comparable closed cases. Used the 25% prior.');

    const clockStart = +new Date(sla.startedAt);
    const responseWindow = +new Date(sla.responseDue) - clockStart;
    const responseElapsed = +new Date(now) - clockStart;
    const adjustments = [
      [
        assignee?.maxConcurrent > 0 && assignee.activeLoad / assignee.maxConcurrent >= 0.8,
        0.1,
        'Assigned technician is at least 80% of capacity',
      ],
      [
        !sla.respondedAt && responseElapsed > responseWindow / 2,
        0.15,
        'No acknowledgement after half of the response window',
      ],
      [status === 'PENDING_INFO', 0.1, 'Waiting for reporter information'],
      [escalationLevel > 0, 0.1, 'Incident has been escalated'],
    ];
    for (const [applies, amount, reason] of adjustments) {
      if (applies) {
        probability += amount;
        factors.push(reason + ' (+' + Math.round(amount * 100) + ' percentage points).');
      }
    }
    probability = Math.min(1, Math.max(0, probability));
    return {
      probability,
      level: probability >= 0.7 ? 'HIGH' : probability >= 0.4 ? 'MEDIUM' : 'LOW',
      factors,
    };
  }
}
