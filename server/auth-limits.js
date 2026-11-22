import { tokenHash } from './accounts.js';
import { requireThat } from './validation.js';

const blocked = 'Too many attempts. Try again in a few minutes.';

/** Stores independent IP and normalized account windows in MongoDB across API replicas. */
export class LoginLimiter {
  constructor({
    ipLimit = 30,
    registrationLimit = 12,
    accountLimit = 5,
    windowMs = 300000,
    lockMs = 300000,
  } = {}) {
    Object.assign(this, { ipLimit, registrationLimit, accountLimit, windowMs, lockMs });
  }

  /** Atomically count a request within its IP window. */
  async ip(unit, kind, address) {
    const window = Math.floor(Date.now() / this.windowMs);
    const key = kind + ':' + tokenHash(address) + ':' + window;
    const row = await unit.attempts.findAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * this.windowMs) } },
      { upsert: true },
    );
    const limit = kind === 'register' ? this.registrationLimit : this.ipLimit;
    requireThat(row.count <= limit, blocked, 429);
  }

  #accountKey(email) {
    return 'account:' + tokenHash(email);
  }

  /** Reject sign-in during the normalized account's lockout interval. */
  async checkAccount(unit, email) {
    const row = await unit.attempts.one({
      _id: this.#accountKey(email),
      lockedUntil: { $gt: new Date() },
    });
    requireThat(!row, blocked, 429);
  }

  /** Count a failed verification and lock out repeated attempts temporarily. */
  async failure(unit, email) {
    const now = new Date();
    const limit = this.accountLimit;
    const cutoff = new Date(+now + this.lockMs);
    await unit.attempts.findAndUpdate(
      { _id: this.#accountKey(email) },
      [
        {
          $set: {
            count: {
              $cond: [{ $gt: ['$expiresAt', now] }, { $add: [{ $ifNull: ['$count', 0] }, 1] }, 1],
            },
          },
        },
        {
          $set: {
            lockedUntil: { $cond: [{ $gte: ['$count', limit] }, cutoff, null] },
            expiresAt: cutoff,
          },
        },
      ],
      { upsert: true },
    );
  }

  /** Clear unlocked failures after successful verification. */
  async success(unit, email) {
    await this.checkAccount(unit, email);
    await unit.attempts.delete({
      _id: this.#accountKey(email),
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }],
    });
  }
}
