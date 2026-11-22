import { boolean, choice, integer, isOpen, priorities, requireThat, role, text } from '../validation.js';
import { assignIncident } from '../assignment/service.js';
import { retarget } from '../sla/clock.js';
import { checkSla } from '../sla/monitor.js';
import { policyFor } from '../sla/policy.js';

function assignee(user, incident) {
  requireThat(
    user.role === 'TECHNICIAN' && user.id === incident.assignedTo,
    'Only the assigned technician can do this.',
    403,
  );
}
function reporter(user, incident) {
  requireThat(user.id === incident.reporter, 'Only the reporter can do this.', 403);
}

/** A command applies one actor-authorized change and records its consequences through the event bus. */
export class IncidentAction {
  execute() {
    throw new Error('IncidentAction requires an execute implementation.');
  }
}
/** Select or confirm the technician for a classified or assigned incident. */
export class AssignAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at }, input) {
    role(user, 'ADMINISTRATOR');
    await assignIncident(unit, incident, user, text(input.technician, 'Technician', 0, 80), at);
  }
}
/** Recalculate the SLA target after an administrator priority change. */
export class ChangePriorityAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, event }, input) {
    role(user, 'ADMINISTRATOR');
    requireThat(isOpen(incident), 'Priority can only change on an open incident.', 409);
    const old = incident.priority;
    incident.priority = choice(input.priority, priorities, 'priority');
    const service = await unit.services.get(incident.service);
    retarget(incident.sla, await policyFor(unit, service), incident.priority);
    await event(
      'PRIORITY_CHANGED',
      'Priority changed from ' + old + ' to ' + incident.priority + '. SLA deadlines recalculated.',
    );
  }
}
/** Record the assigned technician’s first response. */
export class AcknowledgeAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }) {
    assignee(user, incident);
    await checkSla(unit, incident, at);
    incident.acknowledge(at);
    await event('ACKNOWLEDGED', 'Technician acknowledged incident.');
  }
}
/** Start or resume investigation for the current assignee. */
export class InvestigateAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ user, incident, at, event }) {
    assignee(user, incident);
    requireThat(
      ['ACKNOWLEDGED', 'PENDING_INFO'].includes(incident.status),
      'Start investigation after acknowledgement or while waiting for information.',
      409,
    );
    incident.transition('IN_PROGRESS', at);
    await event('INVESTIGATION_STARTED', 'Investigation started.');
  }
}
/** Record an investigation note from the assignee. */
export class AddNoteAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ user, incident, at, event }, input) {
    assignee(user, incident);
    const note = text(input.text, 'Note', 3, 2000);
    incident.addNote('INVESTIGATION', user.name, note, at);
    await event('NOTE_ADDED', 'Investigation note: ' + note);
  }
}
/** Put the incident on hold while waiting for the reporter. */
export class RequestInfoAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    assignee(user, incident);
    const question = text(input.text, 'Question', 5, 1000);
    await checkSla(unit, incident, at);
    incident.transition('PENDING_INFO', at);
    incident.addNote('INFO_REQUEST', user.name, question, at);
    await event('INFO_REQUESTED', 'Technician requested more information: ' + question);
  }
}
/** Append reporter details and resume a pending investigation. */
export class ReplyAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ user, incident, at, event }, input) {
    reporter(user, incident);
    const details = text(input.text, 'Information', 3, 2000);
    if (incident.status === 'PENDING_INFO') {
      incident.transition('IN_PROGRESS', at);
      incident.addNote('INFO_RESPONSE', user.name, details, at);
      await event('INFO_PROVIDED', details);
    } else {
      incident.addNote('USER_INFO', user.name, details, at);
      await event('NOTE_ADDED', 'Reporter added information: ' + details);
    }
  }
}
/** Record a proposed resolution and release technician capacity. */
export class ResolveAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    assignee(user, incident);
    const resolution = text(input.text, 'Resolution', 10, 2000);
    await checkSla(unit, incident, at);
    incident.resolve(resolution, user.name, at);
    await unit.users.changeLoad(incident.assignedTo, -1);
    await event('RESOLVED', 'Resolution provided: ' + resolution);
  }
}
/** Accept the fix with feedback or reopen it for more work. */
export class VerifyAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    reporter(user, incident);
    requireThat(
      incident.status === 'RESOLVED',
      'Only a resolved incident can be verified or reopened.',
      409,
    );
    if (boolean(input.accepted, 'Decision')) {
      incident.verify(integer(input.rating, 'Rating', 1, 5), text(input.comment, 'Comment'), at);
      await event('VERIFIED', 'Reporter verified the resolution.');
      await event(
        'FEEDBACK_SUBMITTED',
        'Feedback: ' + incident.feedback.rating + '/5 ' + incident.feedback.comment,
        'VERIFIED',
      );
    } else {
      const reason = text(input.comment, 'Reason', 5, 1000);
      incident.reopen(reason, user.name, at);
      // Reopened work returns to its current owner even if the new-assignment capacity is now full.
      await unit.users.changeLoad(incident.assignedTo, 1);
      await event('REOPENED', 'Resolution rejected: ' + reason);
    }
  }
}
/** Close an already verified ticket. */
export class CloseAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ user, incident, at, event }, input) {
    if (user.role !== 'ADMINISTRATOR') assignee(user, incident);
    incident.close(text(input.text, 'Closure note') || 'Closed after verification', user.name, at);
    await event('CLOSED', 'Incident closed: ' + incident.closureNote);
  }
}
/** Allow the reporter to terminate their open incident. */
export class CancelAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    reporter(user, incident);
    requireThat(isOpen(incident), 'Only an open incident can be cancelled.', 409);
    const reason = text(input.text, 'Cancellation reason', 5, 1000);
    await checkSla(unit, incident, at);
    incident.cancel(reason, user.name, at);
    await unit.users.changeLoad(incident.assignedTo, -1);
    await event('CANCELLED', 'Reporter cancelled the incident: ' + reason);
  }
}
/** Return an unacknowledged assignment to the manual queue. */
export class DeclineAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    assignee(user, incident);
    requireThat(
      incident.status === 'ASSIGNED',
      'An assignment can be declined before acknowledgement.',
      409,
    );
    const reason = text(input.text, 'Decline reason', 5, 1000);
    await unit.users.changeLoad(incident.assignedTo, -1);
    incident.releaseAssignment('ASSIGNMENT_DECLINED', reason, user.name, at);
    await event('ASSIGNMENT_DECLINED', 'Assignment declined: ' + reason, undefined, user.id);
  }
}
/** Allow an administrator to clear the current technician. */
export class UnassignAction extends IncidentAction {
  /** @inheritdoc */
  async execute({ unit, user, incident, at, event }, input) {
    role(user, 'ADMINISTRATOR');
    requireThat(
      isOpen(incident) && incident.assignedTo,
      'Choose an open incident with an assignee.',
      409,
    );
    const reason = text(input.text, 'Unassignment reason', 5, 1000);
    const priorAssignee = incident.assignedTo;
    await unit.users.changeLoad(priorAssignee, -1);
    incident.releaseAssignment('UNASSIGNED', reason, user.name, at);
    await event(
      'UNASSIGNED',
      'Administrator cleared the assignment: ' + reason,
      undefined,
      priorAssignee,
    );
  }
}

export const commands = new Map([
  ['assign', new AssignAction()],
  ['priority', new ChangePriorityAction()],
  ['acknowledge', new AcknowledgeAction()],
  ['investigate', new InvestigateAction()],
  ['note', new AddNoteAction()],
  ['request-info', new RequestInfoAction()],
  ['reply', new ReplyAction()],
  ['resolve', new ResolveAction()],
  ['verify', new VerifyAction()],
  ['close', new CloseAction()],
  ['cancel', new CancelAction()],
  ['decline', new DeclineAction()],
  ['unassign', new UnassignAction()],
]);
