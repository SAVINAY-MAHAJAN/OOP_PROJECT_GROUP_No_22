import {
  randomBytes,
  timingSafeEqual,
  pbkdf2 as derivePbkdf2,
  scrypt as deriveScrypt,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import { defaultCompanyDomain, roles } from '../shared/constants.js';
import { text, choice, requireThat } from './validation.js';
import { Technician, UserFactory } from './domain/users.js';
import { accountEvent } from './events.js';

const pbkdf2 = promisify(derivePbkdf2);
const scrypt = promisify(deriveScrypt);
const scryptCost = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummyHash = 'scrypt-v2:bmV4b3JhLWR1bW15LWtleQ==:l20X92jkePrV+uHoE0kdfqtjZJORt9znjZ7c/NeJHFw=';
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function normalizeEmail(input, domain = defaultCompanyDomain) {
  const username = text(input, 'E-mail', 1, 254).toLowerCase();
  return username.includes('@') ? username : username + '@' + domain;
}
function validPassword(value) {
  requireThat(
    typeof value === 'string' &&
      value.length >= 8 &&
      value.length <= 256 &&
      /[a-z]/i.test(value) &&
      /\d/.test(value),
    'Use 8–256 characters with at least one letter and one digit.',
  );
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, 32, scryptCost);
  return ['scrypt-v2', salt.toString('base64'), digest.toString('base64')].join(':');
}
export async function matches(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  const [salt, key] = parts.slice(-2).map((part) => Buffer.from(part, 'base64'));
  if (parts.length < 2 || key?.length !== 32) return false;
  let value;
  if (parts[0] === 'scrypt-v2') value = await scrypt(password, salt, 32, scryptCost);
  else if (parts[0] === 'scrypt') value = await scrypt(password, salt, 32);
  else value = await pbkdf2(password, salt, 20000, 32, 'sha256');
  return timingSafeEqual(value, key);
}

export const technicianFields = (input) => Technician.details(input);

export async function prepareUser(input, assignedRole, domain = defaultCompanyDomain) {
  const role = choice(assignedRole, roles, 'role');
  const email = normalizeEmail(input.email, domain);
  requireThat(
    /^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(email) && email.split('@')[1] === domain,
    'Please use your company e-mail address: username@' + domain + '.',
  );
  const name = text(input.name, 'Name', 2, 60);
  validPassword(input.password);
  const account = UserFactory.create(role, { ...input, name, email, passwordHash: null });
  account.passwordHash = await hashPassword(input.password);
  return account.toDocument();
}

export async function createUser(unit, prepared) {
  requireThat(
    !(await unit.users.byEmail(prepared.email)),
    'A user with this e-mail already exists.',
    409,
  );
  const prefix = { EMPLOYEE: 'E', TECHNICIAN: 'T', ADMINISTRATOR: 'A' }[prepared.role];
  const id = await unit.counters.next(prefix);
  const user = UserFactory.from({
    ...prepared,
    _id: id,
    id,
    active: true,
    createdAt: new Date(),
    passwordChangedAt: null,
  });
  await unit.users.insert(user.toDocument());
  return user;
}

export async function verifyLogin(unit, input, domain, limiter) {
  const email = normalizeEmail(input.email, domain);
  const password = input.password;
  requireThat(
    typeof password === 'string' && password.length > 0 && password.length <= 256,
    'Enter both e-mail and password.',
  );
  await limiter.checkAccount(unit, email);
  const account = await unit.users.byEmail(email);
  const encoded = account?.passwordHash || dummyHash;
  // Run the same current-cost derivation for an unknown name and a legacy imported hash.
  const work = [matches(password, encoded)];
  if (!encoded.startsWith('scrypt-v2:')) work.push(matches(password, dummyHash));
  const [valid] = await Promise.all(work);
  if (!account?.active || !valid) {
    await limiter.failure(unit, email);
    requireThat(false, 'Invalid e-mail or password.', 401);
  }
  await limiter.success(unit, email);
  return account;
}

export async function authenticated(unit, key) {
  requireThat(key, 'Sign in to continue.', 401);
  const session = await unit.sessions.current(key, new Date());
  requireThat(session, 'Sign in to continue.', 401);
  const user = await unit.users.byId(session.userId);
  requireThat(
    user?.active && user.authVersion === (session.authVersion || 0),
    'Sign in to continue.',
    401,
  );
  return user;
}

export async function issueSession(repo, account, key, expiresAt) {
  const unit = await repo.read();
  await unit.sessions.insert({
    _id: key,
    userId: account.id,
    authVersion: account.authVersion,
    expiresAt,
  });
  try {
    const current = await unit.users.byId(account.id);
    requireThat(
      current?.active && current.authVersion === account.authVersion,
      'Sign in again to continue.',
      401,
    );
    await accountEvent(unit, current, 'LOGIN', 'Signed in with a password.');
    return current;
  } catch (error) {
    await unit.sessions.delete({ _id: key });
    throw error;
  }
}

export async function preparePasswordChange(user, input) {
  requireThat(await matches(input.current, user.passwordHash), 'Current password is incorrect.');
  validPassword(input.password);
  requireThat(input.current !== input.password, 'Use a different new password.');
  return { expectedVersion: user.authVersion, passwordHash: await hashPassword(input.password) };
}

export async function changePassword(unit, user, prepared, sessionId) {
  requireThat(user.authVersion === prepared.expectedVersion, 'The account changed. Try again.', 409);
  const result = await unit.users.findAndUpdate(
    { _id: user.id, authVersion: prepared.expectedVersion, active: true },
    {
      $set: { passwordHash: prepared.passwordHash, passwordChangedAt: new Date() },
      $inc: { authVersion: 1 },
    },
  );
  requireThat(result, 'The account changed. Try again.', 409);
  await unit.sessions.deleteMany({ userId: user.id, _id: { $ne: sessionId } });
  await unit.sessions.update({ _id: sessionId }, { $set: { authVersion: result.authVersion } });
  const updated = UserFactory.from(result);
  await accountEvent(unit, updated, 'PASSWORD_CHANGED', 'Password changed and other sessions revoked.');
  return updated;
}

const samples = [
  ['Employee', 'ravi', 'Emp@1234'],
  ['Technician', 'arjun', 'Tech@1234'],
  ['Administrator', 'manager', 'Admin@123'],
];
export async function demoAccounts(unit) {
  return Promise.all(
    samples.map(async ([role, name, password]) => {
      const email = name + '@' + defaultCompanyDomain;
      const account = await unit.users.byEmail(email);
      const unchanged = account?.active && (await matches(password, account.passwordHash));
      return { role, email, password: unchanged ? password : null };
    }),
  );
}
