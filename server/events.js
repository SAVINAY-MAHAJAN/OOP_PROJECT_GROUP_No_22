import { label } from './validation.js';
import { InAppChannel, EmailChannel, SmsChannel } from './notifications/channels.js';
import { SseChannel } from './notifications/live.js';

const headlines = {
  ASSIGNMENT_FAILED: 'needs manual assignment',
  RESOLVED: 'resolved - please verify',
  VERIFIED: 'resolution verified',
  SLA_WARNING: 'SLA deadline approaching',
  SLA_VIOLATED: 'SLA VIOLATED',
  ESCALATED: 'ESCALATED',
  DUPLICATE_SUSPECTED: 'possible duplicate',
  OUTAGE_SUSPECTED: 'possible service outage',
  INFO_REQUESTED: 'more information requested',
  INFO_PROVIDED: 'information provided',
  CANCELLED: 'cancelled',
  ASSIGNMENT_DECLINED: 'assignment declined',
  UNASSIGNED: 'unassigned',
  SLA_RISK_PREDICTED: 'predicted SLA breach',
};
const auditOnly = new Set(['CLASSIFIED', 'PRIORITY_CALCULATED', 'NOTE_ADDED', 'FEEDBACK_SUBMITTED']);
const targets = {
  CREATED: ['reporter', 'admins'],
  DUPLICATE_SUSPECTED: ['admins'],
  ASSIGNMENT_FAILED: ['admins'],
  OUTAGE_SUSPECTED: ['admins'],
  PRIORITY_CHANGED: ['reporter', 'tech'],
  ASSIGNED: ['reporter', 'tech'],
  INFO_PROVIDED: ['tech'],
  VERIFIED: ['tech'],
  REOPENED: ['tech', 'admins'],
  CLOSED: ['reporter', 'tech'],
  SLA_WARNING: ['tech', 'admins'],
  SLA_VIOLATED: ['tech', 'admins'],
  ESCALATED: ['extra', 'admins'],
  CANCELLED: ['tech', 'admins'],
  ASSIGNMENT_DECLINED: ['reporter', 'admins'],
  UNASSIGNED: ['reporter', 'extra'],
  SLA_RISK_PREDICTED: ['tech', 'admins'],
};

/** Each observer processes one consequence of a domain event. */
export class EventObserver {
  /** Handle an event within its unit of work. */
  react() {
    throw new Error('EventObserver requires a react implementation.');
  }
}
export class EventBus {
  #observers;
  constructor(observers) {
    this.#observers = observers;
  }

  /** Visit the registered observers in registration order. */
  async publish(unit, event) {
    for (const observer of this.#observers) await observer.react(unit, event);
  }
}
export class AuditObserver extends EventObserver {
  /** Append a write-once audit record without credentials or session content. */
  async react(unit, event) {
    const { incident, actor, action, previousState, description, at } = event;
    const id = await unit.counters.next('AUD');
    await unit.audit.append({
      _id: id,
      id,
      incidentId: incident?.id || null,
      accountId: event.accountId || null,
      actor: actor ? label(actor.role) + ' ' + actor.id + ' (' + actor.name + ')' : 'System',
      action,
      previousState: previousState ?? null,
      newState: incident?.status ?? null,
      description,
      timestamp: at,
    });
  }
}

/** Builds a notice with stable data across delivery mechanisms. */
export class NotificationFactory {
  /** Compose the channel record for one recipient and one event. */
  build(id, recipient, { incident, action, description, at }, channel) {
    const priority = incident.priority ? ' [' + incident.priority + ']' : '';
    const headline = headlines[action] || action.toLowerCase().replaceAll('_', ' ');
    return {
      _id: id,
      id,
      recipientId: recipient.id,
      recipientName: recipient.name,
      channel,
      subject: incident.id + priority + ' ' + headline,
      message: description,
      incidentId: incident.id,
      createdAt: at,
    };
  }
}

/** Selects the event audience and dispatches to registered notification adapters. */
export class NotificationObserver extends EventObserver {
  constructor(channels, factory = new NotificationFactory()) {
    super();
    this.channels = channels;
    this.factory = factory;
  }

  /** Reserve notification IDs in recipient order, then dispatch per channel phase. */
  async react(unit, event) {
    const { incident, action, actor, extra } = event;
    if (!incident || auditOnly.has(action)) return;
    const groups = targets[action] || ['reporter'];
    const references = { reporter: incident.reporter, tech: incident.assignedTo, extra };
    const ids = groups.map((group) => references[group]).filter(Boolean);
    const audience = [{ _id: { $in: ids } }];
    if (groups.includes('admins')) audience.push({ role: 'ADMINISTRATOR' });
    const users = await unit.users.find(
      { active: true, _id: { $ne: actor?.id || '' }, $or: audience },
      { projection: { id: 1, name: 1, email: 1 } },
    );
    const byId = new Map(users.map((user) => [user.id, user]));
    const recipients = [...new Set([...ids, ...users.map((user) => user.id)])]
      .map((id) => byId.get(id))
      .filter(Boolean);
    const deliveries = recipients.map((recipient) => ({
      recipient,
      channels: this.channels.filter((channel) => channel.supports(event, recipient)),
    }));
    const count = deliveries.reduce(
      (total, { channels }) =>
        total + channels.filter((channel) => channel.phase === 'transaction').length,
      0,
    );
    const idsForChannels = count ? await unit.counters.reserve('NTF', count) : [];
    let index = 0;
    for (const { recipient, channels } of deliveries) {
      let inbox;
      for (const channel of channels) {
        if (channel.phase === 'afterCommit') {
          if (inbox) {
            const notice = inbox;
            unit.afterCommit(() => channel.deliver(notice, recipient));
          }
          continue;
        }
        const notice = this.factory.build(idsForChannels[index++], recipient, event, channel.name);
        if (channel.name === 'IN_APP') inbox = notice;
        await channel.deliver(notice, recipient, unit);
      }
    }
  }
}

/** Creates the set of observers and channels used by the application. */
export function makeEventBus(live) {
  return new EventBus([
    new AuditObserver(),
    new NotificationObserver([
      new InAppChannel(),
      new EmailChannel(),
      new SmsChannel(),
      new SseChannel(live),
    ]),
  ]);
}

export function recordEvent(
  unit,
  incident,
  actor,
  action,
  previousState,
  description,
  at,
  extra = null,
) {
  const id = incident.id;
  if (unit.live.count()) unit.afterCommit(() => unit.live.incidentChanged(id, extra), 'incident:' + id);
  return unit.events.publish(unit, { incident, actor, action, previousState, description, at, extra });
}
export function accountEvent(unit, actor, action, description) {
  return unit.events.publish(unit, { actor, accountId: actor.id, action, description, at: new Date() });
}
