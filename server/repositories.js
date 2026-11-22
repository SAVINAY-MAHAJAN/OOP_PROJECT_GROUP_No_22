import { requireThat } from './validation.js';
import { UserFactory } from './domain/users.js';

const idOffsets = { E: 100, T: 200, A: 300, INC: 1000 };

/** Session-bound repository. The MongoDB handle is private to this layer. */
export class MongoRepository {
  #collection;
  #session;
  constructor(collection, session) {
    this.#collection = collection;
    this.#session = session;
  }

  /** Materialize matching records. */
  find(filter = {}, options = {}) {
    return this.#collection.find(filter, { ...options, session: this.#session }).toArray();
  }
  /** Stream matching records for exports or rolling aggregates. */
  scan(filter = {}, options = {}) {
    return this.#collection.find(filter, { ...options, session: this.#session });
  }
  /** Return the first matching record or null. */
  one(filter, options = {}) {
    return this.#collection.findOne(filter, { ...options, session: this.#session });
  }
  /** Fetch a required record by ID. */
  async get(id) {
    const result = await this.one({ _id: id });
    requireThat(result, 'Record could not be found.', 404);
    return result;
  }
  /** Insert one new record. */
  insert(record) {
    return this.#collection.insertOne(record, { session: this.#session });
  }
  /** Insert records in the given order. */
  insertMany(records) {
    return this.#collection.insertMany(records, { session: this.#session });
  }
  /** Count matching documents. */
  count(filter = {}) {
    return this.#collection.countDocuments(filter, { session: this.#session });
  }
  /** Evaluate a reporting pipeline using the bound session. */
  aggregate(pipeline) {
    return this.#collection.aggregate(pipeline, { session: this.#session }).toArray();
  }
  /** Update one matching document. */
  update(filter, changes) {
    return this.#collection.updateOne(filter, changes, { session: this.#session });
  }
  /** Update all matching documents. */
  updateMany(filter, changes) {
    return this.#collection.updateMany(filter, changes, { session: this.#session });
  }
  /** Atomically update and return a matching document. */
  findAndUpdate(filter, changes, options = {}) {
    return this.#collection.findOneAndUpdate(filter, changes, {
      returnDocument: 'after',
      ...options,
      session: this.#session,
    });
  }
  /** Atomically remove and return the matching document. */
  findAndDelete(filter) {
    return this.#collection.findOneAndDelete(filter, { session: this.#session });
  }
  /** Remove one matching document. */
  delete(filter) {
    return this.#collection.deleteOne(filter, { session: this.#session });
  }
  /** Remove all matching documents. */
  deleteMany(filter) {
    return this.#collection.deleteMany(filter, { session: this.#session });
  }
}

/** Hydrates accounts and updates technician capacity conditionally. */
export class UserRepository extends MongoRepository {
  /** Load an account by identifier. */
  async byId(id) {
    return UserFactory.from(await this.one({ _id: id }));
  }
  /** Load an account by its normalized address. */
  async byEmail(email) {
    return UserFactory.from(await this.one({ email }));
  }

  /** Reserve one capacity slot if the technician is eligible. */
  async reserve(id) {
    return this.findAndUpdate(
      {
        _id: id,
        role: 'TECHNICIAN',
        active: true,
        available: true,
        $expr: { $lt: ['$activeLoad', '$maxConcurrent'] },
      },
      { $inc: { activeLoad: 1 } },
    );
  }
  /** Reconcile capacity as an assigned case closes, reopens or changes hands. */
  async changeLoad(id, amount) {
    if (!id) return;
    const filter = { _id: id, role: 'TECHNICIAN' };
    if (amount < 0) filter.activeLoad = { $gt: 0 };
    const result = await this.update(filter, { $inc: { activeLoad: amount } });
    if (!result.matchedCount)
      throw new Error('Technician workload and incident ownership are inconsistent.');
  }
}

/** Persists incident aggregates and related links without leaking the collection. */
export class IncidentRepository extends MongoRepository {
  /** Related links and monitoring updates are independent of the workflow version. */
  async saveWorkflow(incident, version) {
    const { _id, relatedIds, requestId, ...fields } = incident.snapshot();
    const updated = await this.update({ _id, version }, { $set: fields });
    requireThat(updated.matchedCount, 'This incident changed. Refresh its details and try again.', 409);
  }
  /** Add the reverse links without changing any linked workflow version. */
  linkRelated(ids, id) {
    return this.updateMany({ _id: { $in: ids } }, { $addToSet: { relatedIds: id } });
  }
}

/** Resolves an unexpired session. */
export class SessionRepository extends MongoRepository {
  /** Check expiry explicitly, independent of the database cleanup delay. */
  current(id, at) {
    return this.one({ _id: id, expiresAt: { $gt: at } });
  }
}

/** Appends durable audit records. */
export class AuditRepository extends MongoRepository {
  /** Store one historical event. */
  append(event) {
    return this.insert(event);
  }
}

/** Allocates sequence numbers independently of workflow transactions. */
export class CounterRepository extends MongoRepository {
  /** Runs outside the transaction. Aborted attempts may leave a gap and cannot reuse an ID. */
  async reserve(prefix, count = 1) {
    const { value } = await this.findAndUpdate(
      { _id: prefix },
      { $inc: { value: count } },
      { upsert: true },
    );
    const offset = idOffsets[prefix] || 0;
    return Array.from({ length: count }, (_, index) => prefix + (offset + value - count + index + 1));
  }

  /** Allocate one identifier with the existing type prefix. */
  async next(prefix) {
    return (await this.reserve(prefix))[0];
  }
}
