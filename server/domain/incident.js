import { requireThat } from '../validation.js';
import { pauseResolution, resumeResolution } from '../sla/clock.js';
import { stateByName } from './states.js';

/** Ticket aggregate owns lifecycle, SLA pause transitions, notes and workflow version. */
export class Incident {
  #state;
  constructor(record) {
    Object.assign(this, record);
    this.#state = stateByName[record.status];
    if (!this.#state) throw new Error('Unrecognized incident state.');
  }

  /** Read the current immutable state object. */
  get state() {
    return this.#state;
  }

  /** Create a report with the initial lifecycle fields and any supplied metadata. */
  static draft(fields) {
    return new Incident({
      status: 'NEW',
      priority: null,
      assignedTo: null,
      notes: [],
      relatedIds: [],
      escalationLevel: 0,
      version: 1,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      closedBy: null,
      closedAt: null,
      closureNote: null,
      feedback: null,
      ...fields,
    });
  }

  /** Apply a legal transition, including pausing and resuming the resolution clock. */
  transition(status, at) {
    requireThat(
      this.#state.canGoTo(status),
      'This action is unavailable while the incident is ' + this.status + '.',
      409,
    );
    if (this.status === 'PENDING_INFO') resumeResolution(this.sla, at);
    if (status === 'PENDING_INFO') pauseResolution(this.sla, at);
    this.#state = stateByName[status];
    this.status = status;
    this.updatedAt = at;
  }

  /** Classify the report and attach its resolved SLA policy. */
  classify(priority, sla, at) {
    this.transition('CLASSIFIED', at);
    this.priority = priority;
    this.sla = sla;
  }

  /** Assign or reassign a ticket allowed to enter the assigned state. */
  assign(technician, at) {
    if (this.status === 'ASSIGNED') this.updatedAt = at;
    else this.transition('ASSIGNED', at);
    this.assignedTo = technician;
  }

  /** Record first response without rewriting a previous acknowledgement. */
  acknowledge(at) {
    this.transition('ACKNOWLEDGED', at);
    this.sla.respondedAt ??= at;
  }

  /** Append a conversation entry while the ticket is open. */
  addNote(kind, author, text, at) {
    requireThat(this.#state.open, 'Notes can only be added to open incidents.', 409);
    this.notes.push({ kind, author, text, at });
    this.updatedAt = at;
  }

  /** Store the resolution narrative and the measured resolution time. */
  resolve(text, author, at) {
    this.transition('RESOLVED', at);
    Object.assign(this, { resolution: text, resolvedBy: author, resolvedAt: at });
    this.sla.resolvedAt = at;
    this.notes.push({ kind: 'RESOLUTION', author, text, at });
  }

  /** Resume resolution measurement after the reporter rejects the fix. */
  reopen(text, author, at) {
    this.transition('IN_PROGRESS', at);
    this.sla.resolvedAt = null;
    this.addNote('REOPEN_REASON', author, text, at);
  }

  /** Record the reporter's verification and feedback. */
  verify(rating, comment, at) {
    this.transition('VERIFIED', at);
    this.feedback = { rating, comment, at };
  }

  /** Finish a verified case and persist closure details. */
  close(text, author, at) {
    this.transition('CLOSED', at);
    Object.assign(this, { closureNote: text, closedBy: author, closedAt: at });
  }

  /** Move the incident to manual assignment with a reason in its history. */
  releaseAssignment(kind, text, author, at) {
    this.transition('CLASSIFIED', at);
    this.assignedTo = null;
    this.addNote(kind, author, text, at);
  }

  /** Stop an open incident and freeze the SLA clock as of cancellation. */
  cancel(text, author, at) {
    this.addNote('CANCELLED', author, text, at);
    this.transition('CANCELLED', at);
    if (this.sla) this.sla.stoppedAt = at;
    Object.assign(this, { cancelReason: text, cancelledBy: author, cancelledAt: at });
  }

  /** Return the persistent fields without the private state instance. */
  snapshot() {
    return { ...this };
  }
}
