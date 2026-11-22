export class Problem extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export function requireThat(condition, message, status = 400, details) {
  if (!condition) throw new Problem(status, message, details);
}
export function text(value, label, min = 0, max = 2000) {
  requireThat(typeof value === 'string' || (min === 0 && value == null), label + ' must be text.');
  const clean = (value || '').trim();
  requireThat(
    clean.length >= min && clean.length <= max,
    label + ' must be between ' + min + ' and ' + max + ' characters.',
  );
  return clean;
}
export function integer(value, label, min, max) {
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  requireThat(
    Number.isSafeInteger(n) && n >= min && n <= max,
    label + ' must be a whole number between ' + min + ' and ' + max + '.',
  );
  return n;
}
export function choice(value, options, label) {
  requireThat(options.includes(value), 'Choose a valid ' + label + '.');
  return value;
}
export function boolean(value, label) {
  requireThat(typeof value === 'boolean', label + ' must be true or false.');
  return value;
}
export function words(value, label) {
  const items = Array.isArray(value) ? value : text(value, label, 0, 2000).split(',');
  requireThat(items.length <= 100, 'Too many ' + label + '.');
  return [...new Set(items.map((x) => text(x, label, 0, 80)).filter(Boolean))];
}
export function role(user, ...roles) {
  requireThat(
    user && roles.includes(user.role),
    'Your role does not have permission for this action.',
    403,
  );
}
export const isOpen = (i) => openStates.includes(i.status);
export const label = (s) =>
  s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replaceAll('_', ' ') : '';
export const nowAt = (settings) => new Date(Date.now() + (settings.clockOffsetMinutes || 0) * 60000);
import { openStates } from '../shared/constants.js';
export {
  levels,
  priorities,
  roles,
  strategies,
  priorityStrategies,
  openStates,
  states,
} from '../shared/constants.js';
