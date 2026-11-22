import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { defaultCompanyDomain, openStates } from '../shared/constants.js';
import { requireThat } from './validation.js';
import {
  MongoRepository,
  UserRepository,
  IncidentRepository,
  SessionRepository,
  AuditRepository,
  CounterRepository,
} from './repositories.js';
import { makeEventBus } from './events.js';
import { LiveStreams } from './notifications/live.js';

const indexes = {
  users: [[{ email: 1 }, { unique: true }], [{ role: 1, active: 1 }]],
  incidents: [
    [{ reporter: 1, priority: 1, createdAt: -1 }],
    [{ assignedTo: 1, status: 1 }],
    [{ service: 1, createdAt: -1 }],
    [{ priority: 1, createdAt: -1 }],
    [{ status: 1, closedAt: -1 }],
    [{ sampleTag: 1 }, { unique: true, partialFilterExpression: { sampleTag: { $type: 'string' } } }],
    [
      { reporter: 1, requestId: 1 },
      { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } },
    ],
  ],
  audit: [[{ incidentId: 1, timestamp: 1 }], [{ timestamp: -1 }]],
  notifications: [[{ recipientId: 1, createdAt: -1 }]],
  emailOutbox: [[{ createdAt: -1 }]],
  smsOutbox: [[{ createdAt: -1 }]],
  sessions: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }], [{ userId: 1 }]],
  attempts: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
};

const dateKeys = new Set([
  'at',
  'timestamp',
  'createdAt',
  'updatedAt',
  'startedAt',
  'respondedAt',
  'resolvedAt',
  'closedAt',
  'passwordChangedAt',
  'responseDue',
  'resolutionDue',
]);
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
const collectionNames = [
  'users',
  'incidents',
  'audit',
  'services',
  'categories',
  'policies',
  'notifications',
  'emailOutbox',
  'smsOutbox',
  'sessions',
  'attempts',
  'counters',
  'settings',
];
const repositoryTypes = {
  users: UserRepository,
  incidents: IncidentRepository,
  sessions: SessionRepository,
  audit: AuditRepository,
};
const schemaVersion = 2;

/** Gives application operations session-bound repositories and a post-commit queue. */
export class UnitOfWork {
  #afterCommit = new Map();
  constructor(db, session, settings, events, live) {
    this.settings = settings;
    this.events = events;
    this.live = live;
    for (const name of collectionNames) {
      const Type = repositoryTypes[name] || MongoRepository;
      this[name === 'settings' ? 'settingsRepository' : name] = new Type(db.collection(name), session);
    }
    this.counters = new CounterRepository(db.collection('counters'));
  }

  /** Register a callback on this attempt. Named keys coalesce repeated changes to a ticket. */
  afterCommit(callback, key = Symbol()) {
    this.#afterCommit.set(key, callback);
  }

  /** Dispatch only the callbacks from the transaction attempt that committed. */
  async flush() {
    for (const publish of this.#afterCommit.values()) {
      try {
        await publish();
      } catch (error) {
        console.error('Live update failed', error.name);
      }
    }
  }
}

/** Owns MongoDB access, transactions and the process-local live registry. */
export class Repository {
  #client;
  #db;
  #events;
  constructor(client, db) {
    this.#client = client;
    this.#db = db;
    this.live = new LiveStreams(() => this.read());
    this.#events = makeEventBus(this.live);
  }
  async #unit(session) {
    const settings = await this.#db.collection('settings').findOne({ _id: 'global' }, { session });
    return new UnitOfWork(this.#db, session, settings, this.#events, this.live);
  }
  /** Return a unit for reads and independent atomic operations. */
  read() {
    return this.#unit();
  }
  /** Run the callback in a MongoDB transaction and flush the successful attempt. */
  async change(operation) {
    const { result, unit } = await this.#client.withSession((session) =>
      session.withTransaction(async () => {
        const unit = await this.#unit(session);
        return { unit, result: await operation(unit) };
      }, transactionOptions),
    );
    await unit.flush();
    return result;
  }
  /** Verify MongoDB connectivity. */
  ping() {
    return this.#db.command({ ping: 1 });
  }
  /** Release live streams and the database connection pool. */
  close() {
    this.live.close();
    return this.#client.close();
  }
}

function normalizeIncident(document) {
  const fields = { version: document.version ?? 0 };
  if (document.sla) {
    fields.sla = {
      ...document.sla,
      pausedAt:
        document.status === 'PENDING_INFO'
          ? document.sla.pausedAt ||
            document.notes.findLast((note) => note.kind === 'INFO_REQUEST')?.at ||
            document.updatedAt
          : null,
      totalPausedMs: document.sla.totalPausedMs ?? 0,
      stoppedAt: document.sla.stoppedAt ?? null,
    };
  }
  return fields;
}

async function upgrade(db, session, settings) {
  const incidents = db.collection('incidents');
  const loads = new Map();
  for await (const incident of incidents.find({}, { session })) {
    if (openStates.includes(incident.status) && incident.assignedTo) {
      loads.set(incident.assignedTo, (loads.get(incident.assignedTo) || 0) + 1);
    }
    await incidents.updateOne({ _id: incident._id }, { $set: normalizeIncident(incident) }, { session });
  }
  for await (const user of db.collection('users').find({}, { session })) {
    const fields = { authVersion: user.authVersion ?? 0 };
    if (user.role === 'TECHNICIAN') fields.activeLoad = loads.get(user.id) || 0;
    await db.collection('users').updateOne({ _id: user._id }, { $set: fields }, { session });
  }
  for (const [key, value] of Object.entries(settings.sequences || {})) {
    await db
      .collection('counters')
      .updateOne({ _id: key }, { $max: { value } }, { session, upsert: true });
  }
  await db
    .collection('emailOutbox')
    .updateMany(
      { state: { $exists: false } },
      { $set: { state: 'SIMULATED', channel: 'EMAIL' } },
      { session },
    );
  await db
    .collection('smsOutbox')
    .updateMany(
      { state: { $exists: false } },
      { $set: { state: 'SIMULATED', channel: 'SMS' } },
      { session },
    );
  await db.collection('settings').updateOne(
    { _id: 'global' },
    {
      $set: {
        schemaVersion,
        demoMode: settings.demoMode ?? true,
        clockOffsetMinutes: settings.clockOffsetMinutes || 0,
      },
      $unset: { revision: '', sequences: '' },
    },
    { session },
  );
}

async function initialize(db, session, options) {
  const settings = await db.collection('settings').findOne({ _id: 'global' }, { session });
  if (settings) {
    requireThat(
      settings.schemaVersion === 1 || settings.schemaVersion === schemaVersion,
      'This version of Nexora cannot open the selected database schema.',
    );
    requireThat(
      (settings.demoMode ?? true) === options.demoMode,
      'The database mode differs from DEMO_MODE. Select a separate database for demo or staff use.',
    );
    requireThat(
      (settings.companyDomain || defaultCompanyDomain) === options.companyDomain,
      'COMPANY_DOMAIN differs from the organization stored in this database.',
    );
    if (settings.schemaVersion < schemaVersion) await upgrade(db, session, settings);
    return;
  }
  for (const name of collectionNames) {
    if (await db.collection(name).findOne({}, { session, projection: { _id: 1 } })) {
      throw new Error('Initial setup needs an empty Nexora database. Choose a separate MONGODB_DB.');
    }
  }
  const snapshot = JSON.parse(
    await readFile(new URL('./seed/snapshot.json', import.meta.url), 'utf8'),
    (key, value) => (dateKeys.has(key) && typeof value === 'string' ? new Date(value) : value),
  );
  const [initial] = snapshot.settings;
  Object.assign(initial, {
    schemaVersion: 1,
    clockOffsetMinutes: 0,
    demoMode: options.demoMode,
    companyDomain: options.companyDomain,
  });
  if (!options.demoMode) {
    requireThat(
      options.bootstrapAccount?.role === 'ADMINISTRATOR' && options.bootstrapAccount.passwordHash,
      'Set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD for the first staff installation, or use DEMO_MODE=1 locally.',
    );
    snapshot.users = [
      {
        ...options.bootstrapAccount,
        _id: 'A301',
        id: 'A301',
        active: true,
        createdAt: new Date(),
        passwordChangedAt: null,
      },
    ];
    for (const name of ['incidents', 'audit', 'notifications', 'emailOutbox']) snapshot[name] = [];
    initial.sequences = { A: 1, SVC: initial.sequences.SVC, SLA: initial.sequences.SLA };
  }
  for (const [name, records] of Object.entries(snapshot)) {
    if (records.length) await db.collection(name).insertMany(records, { session });
  }
  await upgrade(db, session, initial);
}

export async function connectDatabase(
  uri,
  dbName,
  { demoMode = false, companyDomain = defaultCompanyDomain, bootstrapAccount } = {},
) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = dbName ? client.db(dbName) : client.db();
    const hello = await db.admin().command({ hello: 1 });
    requireThat(
      hello.setName || hello.msg === 'isdbgrid',
      'Nexora requires a MongoDB replica set or sharded cluster.',
    );
    for (const name of collectionNames) {
      try {
        await db.createCollection(name);
      } catch (error) {
        if (error.code !== 48) throw error;
      }
      for (const [keys, options] of indexes[name] || [])
        await db.collection(name).createIndex(keys, options);
    }
    const options = { demoMode, companyDomain, bootstrapAccount };
    try {
      await client.withSession((session) =>
        session.withTransaction(() => initialize(db, session, options), transactionOptions),
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Another instance initialized the database. Confirm the committed mode and schema.
      await client.withSession((session) =>
        session.withTransaction(() => initialize(db, session, options), transactionOptions),
      );
    }
    return new Repository(client, db);
  } catch (error) {
    await client.close();
    throw error;
  }
}
