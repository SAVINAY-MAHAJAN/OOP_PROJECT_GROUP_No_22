import { requireThat } from '../validation.js';
import { NotificationChannel } from './channels.js';

/** Tracks the authenticated SSE responses owned by one API process. */
export class LiveStreams {
  #streams = new Map();
  #timer;
  #read;

  constructor(read) {
    this.#read = read;
  }

  /** Count active connections, optionally for one user. */
  count(userId) {
    if (userId) return this.#streams.get(userId)?.size || 0;
    return [...this.#streams.values()].reduce((total, set) => total + set.size, 0);
  }

  /** Open a same-origin SSE response and clean it up on disconnect. */
  open(userId, sessionKey, response, { legacy = false } = {}) {
    requireThat(
      this.count(userId) < 5,
      'A maximum of five live connections per account is allowed.',
      429,
    );
    const stream = { userId, sessionKey, response, legacy };
    if (!this.#streams.has(userId)) this.#streams.set(userId, new Set());
    this.#streams.get(userId).add(stream);
    response.on('close', () => this.#remove(stream));
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    this.#write(stream, 'retry: 5000\n: connected\n\n');
    if (!this.#timer && this.count()) {
      this.#timer = setInterval(() => this.#heartbeat().catch(() => this.close()), 25000);
      this.#timer.unref();
    }
  }

  #remove(stream) {
    const group = this.#streams.get(stream.userId);
    group?.delete(stream);
    if (group?.size === 0) this.#streams.delete(stream.userId);
    if (this.#streams.size === 0) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #write(stream, chunk) {
    if (stream.response.destroyed) {
      this.#remove(stream);
      return;
    }
    // Slow clients reconnect and fetch current data. Keep their socket buffers bounded.
    if (!stream.response.write(chunk)) this.#end(stream);
  }

  #end(stream) {
    this.#remove(stream);
    stream.response.end();
  }

  async #eligible(unit, group) {
    if (group.length === 0) return [];
    const keys = [...new Set(group.map((stream) => stream.sessionKey))];
    const userIds = [...new Set(group.map((stream) => stream.userId))];
    const sessions = await unit.sessions.find({ _id: { $in: keys }, expiresAt: { $gt: new Date() } });
    const users = await unit.users.find(
      { _id: { $in: userIds }, active: true },
      { projection: { id: 1, role: 1, authVersion: 1 } },
    );
    const byKey = new Map(sessions.map((session) => [session._id, session]));
    const byId = new Map(users.map((user) => [user.id, user]));
    const eligible = [];
    for (const stream of group) {
      const user = byId.get(stream.userId),
        session = byKey.get(stream.sessionKey);
      if (
        user &&
        session?.userId === stream.userId &&
        (user.authVersion || 0) === (session.authVersion || 0)
      )
        eligible.push({ stream, user });
      else this.#end(stream);
    }
    return eligible;
  }

  async #heartbeat() {
    if (!this.count()) return;
    const ready = await this.#eligible(
      await this.#read(),
      [...this.#streams.values()].flatMap((group) => [...group]),
    );
    for (const { stream } of ready) this.#write(stream, ': ping\n\n');
  }

  #event(stream, payload) {
    const event = stream.legacy && payload.type === 'notification' ? 'notifications' : payload.type;
    this.#write(stream, 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
  }

  /** Publish the committed notification envelope to its recipient only. */
  async notification(userId, payload) {
    const streams = this.#streams.get(userId);
    if (!streams) return;
    for (const { stream } of await this.#eligible(await this.#read(), [...streams]))
      this.#event(stream, payload);
  }

  /** Refresh the unread badge across tabs without sending notification content. */
  inboxChanged(userId) {
    return this.notification(userId, { type: 'inbox-changed' });
  }

  /** Invalidate the dashboard after administrator settings or technician capacity change. */
  async dashboardChanged() {
    if (!this.count()) return;
    const unit = await this.#read();
    const eligible = await this.#eligible(
      unit,
      [...this.#streams.values()].flatMap((group) => [...group]),
    );
    for (const { stream, user } of eligible)
      if (user.role === 'ADMINISTRATOR') this.#event(stream, { type: 'dashboard-changed' });
  }

  /** Recheck the current ticket ACL and send lightweight invalidations after commit. */
  async incidentChanged(id, previousAssignee) {
    if (!this.count()) return;
    const unit = await this.#read();
    const incident = await unit.incidents.one(
      { _id: id },
      { projection: { id: 1, reporter: 1, assignedTo: 1 } },
    );
    if (!incident) return;
    const eligible = await this.#eligible(
      unit,
      [...this.#streams.values()].flatMap((group) => [...group]),
    );
    for (const { stream, user } of eligible) {
      const admin = user.role === 'ADMINISTRATOR';
      if (
        admin ||
        user.id === incident.reporter ||
        (user.role === 'TECHNICIAN' && user.id === incident.assignedTo)
      ) {
        this.#event(stream, { type: 'incident-changed', incidentId: id });
      } else if (user.role === 'TECHNICIAN' && user.id === previousAssignee) {
        this.#event(stream, { type: 'workload-changed' });
      }
      if (admin) this.#event(stream, { type: 'dashboard-changed' });
    }
  }

  /** Disconnect a revoked session immediately. */
  disconnect(userId, sessionKey, keepSession = false) {
    for (const stream of this.#streams.get(userId) || []) {
      if (
        keepSession ? stream.sessionKey !== sessionKey : !sessionKey || stream.sessionKey === sessionKey
      )
        this.#end(stream);
    }
  }

  /** Close every connection at HTTP shutdown. */
  close() {
    for (const streams of this.#streams.values()) for (const stream of streams) this.#end(stream);
  }
}

/** Mirrors inbox notices as minimal SSE envelopes after persistence succeeds. */
export class SseChannel extends NotificationChannel {
  constructor(registry) {
    super('SSE', 'afterCommit');
    this.registry = registry;
  }

  /** Live notifications share the existing inbox identifier and audience. */
  deliver(notice, recipient) {
    return this.registry.notification(recipient.id, {
      type: 'notification',
      id: notice.id,
      incidentId: notice.incidentId,
      subject: notice.subject,
    });
  }
}
