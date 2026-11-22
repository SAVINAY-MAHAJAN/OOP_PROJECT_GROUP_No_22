import { text, requireThat } from './validation.js';

const dayMs = 86400000;
const formats = new Map();

export function localDay(value) {
  const day = text(value, 'Date', 10, 10);
  const midnight = new Date(day + 'T00:00:00.000Z');
  requireThat(
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(+midnight) &&
      midnight.toISOString().startsWith(day),
    'Enter a valid date as yyyy-MM-dd.',
  );
  return day;
}

export function shiftDay(day, amount) {
  return new Date(Date.parse(day + 'T00:00:00Z') + amount * dayMs).toISOString().slice(0, 10);
}

export function currentDay(date, zone) {
  if (!formats.has(zone))
    formats.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    );
  const parts = Object.fromEntries(
    formats
      .get(zone)
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
}

/** Finds the start of a local calendar day. An inclusive date range ends at the next local midnight, even across DST. */
export function startOfDay(day, zone) {
  const center = Date.parse(day + 'T00:00:00Z');
  let low = center - 2 * dayMs,
    high = center + 2 * dayMs;
  while (high > low) {
    const mid = Math.floor((low + high) / 2);
    if (currentDay(new Date(mid), zone) < day) low = mid + 1;
    else high = mid;
  }
  return new Date(high);
}
