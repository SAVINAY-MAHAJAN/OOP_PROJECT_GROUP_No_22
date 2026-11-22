import { defaultCompanyDomain, defaultTimeZone } from '../shared/constants.js';
import { integer, requireThat } from './validation.js';

function flag(value, fallback = false) {
  if (value === undefined) return fallback;
  requireThat(
    ['0', '1', 'true', 'false'].includes(value),
    'Use true, false, 0, or 1 for configuration flags.',
  );
  return ['1', 'true'].includes(value);
}
export function canonicalOrigin(value) {
  const url = new URL(value);
  requireThat(
    ['https:', 'http:'].includes(url.protocol) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'APP_ORIGIN must be an HTTP or HTTPS origin without a path.',
  );
  return url.origin;
}
const loopback = (hostname) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
export function readAppConfig(env = process.env) {
  const port = integer(env.PORT || 18120, 'HTTP port', 1024, 65535);
  const host = env.HOST || '127.0.0.1';
  const publicOrigin = env.APP_ORIGIN ? canonicalOrigin(env.APP_ORIGIN) : undefined;
  const publicAddress = publicOrigin && !loopback(new URL(publicOrigin).hostname);
  const allowedHosts = env.ALLOWED_HOSTS
    ? env.ALLOWED_HOSTS.split(',').map((item) => item.trim().toLowerCase())
    : undefined;
  requireThat(
    !allowedHosts ||
      allowedHosts.every((item) => {
        try {
          return new URL('http://' + item).host === item || new URL('https://' + item).host === item;
        } catch {
          return false;
        }
      }),
    'ALLOWED_HOSTS must list hostnames with optional ports.',
  );
  const demoMode = flag(env.DEMO_MODE, !publicAddress && loopback(host));
  const companyDomain = (env.COMPANY_DOMAIN || defaultCompanyDomain).toLowerCase();
  requireThat(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(companyDomain),
    'COMPANY_DOMAIN must be a valid domain.',
  );
  const timeZone = env.APP_TIME_ZONE || defaultTimeZone;
  new Intl.DateTimeFormat('en', { timeZone });
  if (demoMode) {
    requireThat(
      !publicAddress &&
        companyDomain === defaultCompanyDomain &&
        (!allowedHosts || allowedHosts.every((value) => loopback(new URL('http://' + value).hostname))),
      'Use demo mode with loopback browser addresses and the supplied nexora.com accounts.',
    );
  }
  const secureCookie = flag(env.COOKIE_SECURE, publicOrigin?.startsWith('https:') || false);
  requireThat(
    !publicAddress || (publicOrigin.startsWith('https:') && secureCookie && env.MONGODB_URI),
    'A public origin requires HTTPS, Secure cookies and MONGODB_URI.',
  );
  if (env.TRUST_PROXY)
    requireThat(
      env.TRUST_PROXY.split(',').every((value) => !/^(true|1|0\.0\.0\.0\/0|::\/0)$/i.test(value.trim())),
      'TRUST_PROXY must list the trusted proxy addresses or ranges.',
    );
  return {
    port,
    host,
    publicOrigin,
    allowedHosts,
    secureCookie,
    demoMode,
    companyDomain,
    timeZone,
    trustProxy: env.TRUST_PROXY || false,
    registration: flag(env.ALLOW_SELF_REGISTRATION, demoMode),
  };
}
