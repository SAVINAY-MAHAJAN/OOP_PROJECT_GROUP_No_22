/** A channel consumes a notice either inside the transaction or after it commits. */
export class NotificationChannel {
  constructor(name, phase = 'transaction') {
    this.name = name;
    this.phase = phase;
  }

  /** Decide whether this event and recipient are supported. */
  supports() {
    return true;
  }

  /** Handle one notice. */
  deliver() {
    throw new Error('NotificationChannel requires a deliver implementation.');
  }
}
export class InAppChannel extends NotificationChannel {
  constructor() {
    super('IN_APP');
  }

  /** Append to the recipient’s inbox. */
  deliver(notice, recipient, unit) {
    return unit.notifications.insert({ ...notice, read: false });
  }
}
export class EmailChannel extends NotificationChannel {
  constructor() {
    super('EMAIL');
  }

  /** Basic acknowledgement and investigation notices use in-app delivery. */
  supports({ action }) {
    return !['ACKNOWLEDGED', 'INVESTIGATION_STARTED'].includes(action);
  }

  /** Record a simulated email without sending it. */
  deliver(notice, recipient, unit) {
    return unit.emailOutbox.insert({ ...notice, to: recipient.email, state: 'SIMULATED' });
  }
}
export class SmsChannel extends NotificationChannel {
  constructor() {
    super('SMS');
  }

  /** SMS is reserved for urgent assignments, violations, escalation, and outages. */
  supports({ action, incident }) {
    return (
      ['SLA_VIOLATED', 'ESCALATED', 'OUTAGE_SUSPECTED'].includes(action) ||
      (incident.priority === 'P1' && ['CREATED', 'ASSIGNED'].includes(action))
    );
  }

  /** Record a simulated SMS without sending it. */
  deliver(notice, recipient, unit) {
    return unit.smsOutbox.insert({ ...notice, state: 'SIMULATED' });
  }
}
