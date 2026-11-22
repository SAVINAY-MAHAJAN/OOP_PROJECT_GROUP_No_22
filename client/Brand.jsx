import React from 'react';

const highlights = [
  'Smart priority calculation and SLA tracking',
  'Automatic technician assignment',
  'Duplicate and outage detection',
  'Escalation, notifications and a full audit trail',
];

export function LogoMark({ size = 34 }) {
  return (
    <span
      className="logo-mark"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      N
    </span>
  );
}

export function LoginBrand() {
  return (
    <aside className="login-brand" aria-label="Nexora ServiceDesk">
      <div className="login-brand-inner">
        <LogoMark size={56} />
        <div className="brand-words">
          <strong>Nexora</strong>
          <span>ServiceDesk</span>
        </div>
        <p className="tagline">IT Service Management &amp; Incident Resolution</p>
        <ul className="brand-features">
          {highlights.map((label) => (
            <li key={label}>
              <span aria-hidden="true">✓</span>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function HeaderBrand() {
  return (
    <div className="header-brand">
      <LogoMark />
      <strong>Nexora</strong>
      <span className="product-name">ServiceDesk</span>
    </div>
  );
}

export function Avatar({ name = '', size = 36 }) {
  const initials =
    name
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0].toLocaleUpperCase())
      .join('') || '?';
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(12, size * 0.38) }}
    >
      {initials}
    </span>
  );
}

const tones = {
  BREACHED: 'red',
  VIOLATION: 'red',
  VIOLATED: 'red',
  NO: 'red',
  INACTIVE: 'red',
  WARNING: 'amber',
  AT_RISK: 'amber',
  PAUSED: 'amber',
  PENDING_INFO: 'amber',
  ADMINISTRATOR: 'amber',
  ASSIGNED: 'blue',
  UNREAD: 'blue',
  ACKNOWLEDGED: 'purple',
  IN_PROGRESS: 'purple',
  TECHNICIAN: 'purple',
  RESOLVED: 'teal',
  MET: 'teal',
  VERIFIED: 'green',
  ON_TRACK: 'green',
  YES: 'green',
  EMPLOYEE: 'green',
  'ACTIVE ACCOUNT': 'green',
};

function toneFor(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (text.startsWith('ESCALATED') || text.startsWith('P1')) return 'red';
  if (text.startsWith('P2')) return 'amber';
  if (text.startsWith('P3')) return 'blue';
  return tones[text] || 'gray';
}

export function Pill({ value, children, tone }) {
  return (
    <span className="pill" data-tone={tone || toneFor(value ?? children)}>
      {children ?? value}
    </span>
  );
}

export default LogoMark;
