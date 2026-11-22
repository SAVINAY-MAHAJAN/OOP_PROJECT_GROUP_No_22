/** A pending customer reply stops the resolution clock. Completed response metrics stay intact. */
export function newSla(policy, priority, start) {
  return retarget(
    {
      startedAt: start,
      respondedAt: null,
      resolvedAt: null,
      pausedAt: null,
      totalPausedMs: 0,
      stoppedAt: null,
      responseBreached: false,
      resolutionBreached: false,
      responseWarned: false,
      resolutionWarned: false,
      log: [],
    },
    policy,
    priority,
  );
}
export function retarget(sla, policy, priority) {
  const target = policy.targets[priority];
  return Object.assign(sla, {
    policyName: policy.name,
    responseDue: new Date(+sla.startedAt + target.responseMinutes * 60000),
    resolutionDue: new Date(
      +sla.startedAt + target.resolutionMinutes * 60000 + (sla.totalPausedMs || 0),
    ),
  });
}
export function pauseResolution(sla, at) {
  sla.pausedAt ??= at;
}
export function resumeResolution(sla, at) {
  if (!sla?.pausedAt) return;
  const duration = Math.max(0, at - sla.pausedAt);
  sla.totalPausedMs = (sla.totalPausedMs || 0) + duration;
  sla.resolutionDue = new Date(+sla.resolutionDue + duration);
  sla.pausedAt = null;
}

function reached(sla, now, phase, fraction) {
  const excluded = phase === 'resolution' ? sla.totalPausedMs || 0 : 0;
  const duration = Math.floor((sla[phase + 'Due'] - sla.startedAt - excluded) / 1000);
  return Math.floor((now - sla.startedAt - excluded) / 1000) >= fraction * duration;
}

export function slaStatus(sla, now, fraction) {
  if (!sla) return 'ON_TRACK';
  const cutOff = sla.stoppedAt || now;
  const resolutionClock = sla.pausedAt || cutOff;
  if (
    sla.responseBreached ||
    sla.resolutionBreached ||
    (!sla.respondedAt && cutOff > sla.responseDue) ||
    (!sla.resolvedAt && resolutionClock > sla.resolutionDue)
  )
    return 'BREACHED';
  if (sla.stoppedAt) return 'STOPPED';
  if (sla.resolvedAt) return 'MET';
  if (sla.pausedAt) return 'PAUSED';
  return (!sla.respondedAt && reached(sla, now, 'response', fraction)) ||
    reached(sla, now, 'resolution', fraction)
    ? 'AT_RISK'
    : 'ON_TRACK';
}

export function findings(sla, now, fraction) {
  if (sla.stoppedAt) return [];
  const result = [];
  for (const [phase, done] of [
    ['response', sla.respondedAt],
    ['resolution', sla.resolvedAt || sla.pausedAt],
  ]) {
    if (done || sla[phase + 'Breached']) continue;
    let type;
    if (now > sla[phase + 'Due']) {
      sla[phase + 'Breached'] = true;
      type = 'VIOLATION';
    } else if (!sla[phase + 'Warned'] && reached(sla, now, phase, fraction)) {
      sla[phase + 'Warned'] = true;
      type = 'WARNING';
    }
    if (type) {
      const finding = phase.toUpperCase() + '_' + type;
      result.push(finding);
      sla.log.push({ finding, at: now });
    }
  }
  return result;
}
