/** A state controls the transitions the aggregate may make from its current position. */
export class IncidentState {
  constructor(name, { open = false, next = [] } = {}) {
    this.name = name;
    this.open = open;
    this.next = Object.freeze(next);
  }

  /** Whether this state allows the proposed target. */
  canGoTo(target) {
    return this.next.includes(target);
  }
}

/** An initial report may be classified or cancelled. */
export class NewState extends IncidentState {
  constructor() {
    super('NEW', { open: true, next: ['CLASSIFIED', 'CANCELLED'] });
  }
}
/** A classified incident is waiting for assignment. */
export class ClassifiedState extends IncidentState {
  constructor() {
    super('CLASSIFIED', { open: true, next: ['ASSIGNED', 'CANCELLED'] });
  }
}
/** An assignment is pending the technician's acknowledgement. */
export class AssignedState extends IncidentState {
  constructor() {
    super('ASSIGNED', { open: true, next: ['ACKNOWLEDGED', 'CLASSIFIED', 'CANCELLED'] });
  }
}
/** Response was recorded and investigation can start. */
export class AcknowledgedState extends IncidentState {
  constructor() {
    super('ACKNOWLEDGED', { open: true, next: ['IN_PROGRESS', 'CLASSIFIED', 'CANCELLED'] });
  }
}
/** The technician can request details or resolve the case. */
export class InProgressState extends IncidentState {
  constructor() {
    super('IN_PROGRESS', { open: true, next: ['PENDING_INFO', 'RESOLVED', 'CLASSIFIED', 'CANCELLED'] });
  }
}
/** Resolution time is paused until investigation resumes. */
export class PendingInfoState extends IncidentState {
  constructor() {
    super('PENDING_INFO', { open: true, next: ['IN_PROGRESS', 'CLASSIFIED', 'CANCELLED'] });
  }
}
/** The reporter can accept or reject the proposed resolution. */
export class ResolvedState extends IncidentState {
  constructor() {
    super('RESOLVED', { next: ['VERIFIED', 'IN_PROGRESS'] });
  }
}
/** Reporter acceptance makes the incident eligible for closure. */
export class VerifiedState extends IncidentState {
  constructor() {
    super('VERIFIED', { next: ['CLOSED'] });
  }
}
/** A closed case has no further workflow transitions. */
export class ClosedState extends IncidentState {
  constructor() {
    super('CLOSED');
  }
}
/** A reporter-cancelled case has no further workflow transitions. */
export class CancelledState extends IncidentState {
  constructor() {
    super('CANCELLED');
  }
}

export const stateByName = Object.freeze(
  Object.fromEntries(
    [
      new NewState(),
      new ClassifiedState(),
      new AssignedState(),
      new AcknowledgedState(),
      new InProgressState(),
      new PendingInfoState(),
      new ResolvedState(),
      new VerifiedState(),
      new ClosedState(),
      new CancelledState(),
    ].map((state) => [state.name, Object.freeze(state)]),
  ),
);
