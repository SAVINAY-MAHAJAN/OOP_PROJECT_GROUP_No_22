import express from 'express';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { defaultCompanyDomain, defaultTimeZone } from '../shared/constants.js';
import { Problem, requireThat, role, boolean, integer, nowAt, text } from './validation.js';
import {
  verifyLogin,
  prepareUser,
  createUser,
  preparePasswordChange,
  changePassword,
  demoAccounts,
  tokenHash,
  authenticated,
  issueSession,
} from './accounts.js';
import { LoginLimiter } from './auth-limits.js';
import { canonicalOrigin } from './config.js';
import { report, act, resolutions, suggestCategory, accessIncident } from './incidents.js';
import { recommendations } from './assignment/service.js';
import { monitor } from './sla/monitor.js';
import { riskThreshold } from './sla/risk-service.js';
import {
  catalog,
  incidentDetail,
  incidentList,
  dashboard,
  technicianWorkload,
  findingsList,
  paging,
  outbox,
  incidentCsv,
} from './queries.js';
import {
  manageUser,
  saveService,
  saveCategory,
  savePolicy,
  deleteCatalogItem,
  configure,
} from './admin.js';

const cookieName = 'nexora_sid';
const sessionDuration = 8 * 3600000;
function sessionKey(req) {
  const cookie = req.get('cookie')?.match(/(?:^|;\s*)nexora_sid=([0-9a-f]{64})(?:;|$)/);
  return cookie ? tokenHash(cookie[1]) : null;
}
function settingsView(settings) {
  const {
    assignmentStrategyKey,
    priorityStrategyKey,
    escalationStepMinutes,
    slaWarningFraction,
    clockOffsetMinutes,
  } = settings;
  return {
    assignmentStrategyKey,
    priorityStrategyKey,
    escalationStepMinutes,
    slaWarningFraction,
    clockOffsetMinutes,
    riskThresholdPercent: riskThreshold(settings),
    now: nowAt(settings),
  };
}
function data(req) {
  return req.body || {};
}

export function createApp(
  repo,
  {
    port,
    dist,
    demoMode = false,
    registration = demoMode,
    companyDomain = defaultCompanyDomain,
    timeZone = defaultTimeZone,
    publicOrigin,
    trustProxy = false,
    secureCookie = false,
    allowedHosts,
    authLimits,
  } = {},
) {
  const app = express();
  const origin = publicOrigin ? canonicalOrigin(publicOrigin) : undefined;
  const hosts = new Set(
    allowedHosts ||
      (origin ? [new URL(origin).host] : ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]),
  );
  const limiter = new LoginLimiter(authLimits);
  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: secureCookie || origin?.startsWith('https:') || req.secure,
  });
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    requireThat(
      hosts.has(req.get('host')?.toLowerCase()),
      'Open Nexora through its configured address.',
      400,
    );
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  const api = express.Router();
  app.use('/api', api);
  api.use(
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
        const expected =
          origin ||
          new URL((req.secure || secureCookie ? 'https' : 'http') + '://' + req.get('host')).origin;
        requireThat(req.get('origin') === expected, 'The request must come from this application.', 403);
        requireThat(req.is('application/json'), 'Send a JSON request.', 415);
      }
      next();
    },
    express.json({ limit: '24kb' }),
  );

  const actorRead = async (req) => {
    const unit = await repo.read();
    const actor = await authenticated(unit, sessionKey(req));
    return { unit, actor };
  };
  const read =
    (fn, { admin = false, technician = false } = {}) =>
    async (req, res) => {
      const { unit, actor } = await actorRead(req);
      if (admin) role(actor, 'ADMINISTRATOR');
      if (technician) role(actor, 'TECHNICIAN');
      res.json(await fn(unit, actor, req));
    };
  const change =
    (fn, status = 200) =>
    async (req, res) => {
      const key = sessionKey(req);
      await actorRead(req);
      const result = await repo.change(async (unit) =>
        fn(unit, await authenticated(unit, key), req, data(req)),
      );
      res.status(status).json(result ?? {});
    };

  api.get('/health', async (req, res) => {
    await repo.ping();
    res.json({ status: 'ok', application: 'Nexora ServiceDesk', database: 'MongoDB' });
  });
  api.get('/auth/options', (req, res) =>
    res.json({ google: false, demo: demoMode, registration, timeZone, companyDomain }),
  );
  api.get('/auth/samples', async (req, res) =>
    res.json(demoMode ? await demoAccounts(await repo.read()) : []),
  );
  api.post('/auth/login', async (req, res) => {
    const unit = await repo.read();
    await limiter.ip(unit, 'login', req.ip);
    const account = await verifyLogin(unit, data(req), companyDomain, limiter);
    const token = randomBytes(32).toString('hex');
    const user = await issueSession(
      repo,
      account,
      tokenHash(token),
      new Date(Date.now() + sessionDuration),
    );
    res.cookie(cookieName, token, { ...cookieOptions(req), maxAge: sessionDuration });
    res.json(user.publicProfile());
  });
  api.post('/auth/register', async (req, res) => {
    requireThat(registration, 'Self-registration is disabled.', 403);
    await limiter.ip(await repo.read(), 'register', req.ip);
    const prepared = await prepareUser(data(req), 'EMPLOYEE', companyDomain);
    const user = await repo.change((unit) => createUser(unit, prepared));
    res.status(201).json(user.publicProfile());
  });
  api.get(
    '/auth/me',
    read((unit, user) => user.publicProfile()),
  );
  api.post('/auth/logout', async (req, res) => {
    const key = sessionKey(req);
    if (key) {
      const unit = await repo.read(),
        removed = await unit.sessions.findAndDelete({ _id: key });
      if (removed) repo.live.disconnect(removed.userId, key);
    }
    res.clearCookie(cookieName, cookieOptions(req)).json({});
  });
  api.patch('/auth/password', async (req, res) => {
    const key = sessionKey(req),
      { actor } = await actorRead(req);
    await limiter.ip(await repo.read(), 'password', req.ip);
    const prepared = await preparePasswordChange(actor, data(req));
    const changed = await repo.change(async (unit) =>
      changePassword(unit, await authenticated(unit, key), prepared, key),
    );
    repo.live.disconnect(changed.id, key, true);
    res.json(changed.publicProfile());
  });

  api.get(['/events', '/stream'], async (req, res) => {
    requireThat(
      !req.get('origin') ||
        req.get('origin') ===
          (origin ||
            new URL((req.secure || secureCookie ? 'https' : 'http') + '://' + req.get('host')).origin),
      'Open live updates from this application.',
      403,
    );
    const { actor } = await actorRead(req);
    repo.live.open(actor.id, sessionKey(req), res, { legacy: req.path === '/stream' });
  });
  api.get('/catalog', read(catalog));
  api.get(
    '/incidents',
    read((u, a, r) => incidentList(u, a, r.query, timeZone)),
  );
  api.post(
    '/incidents/suggest-category',
    read(async (u, a, r) => ({ category: await suggestCategory(u, data(r)) })),
  );
  api.post('/incidents', async (req, res) => {
    const { actor } = await actorRead(req),
      key = sessionKey(req),
      body = data(req);
    let result;
    try {
      result = await repo.change(async (unit) => report(unit, await authenticated(unit, key), body));
    } catch (error) {
      if (error.code !== 11000 || typeof body.requestId !== 'string') throw error;
      result = await (
        await repo.read()
      ).incidents.one({ reporter: actor.id, requestId: body.requestId.trim() });
      if (!result) throw error;
    }
    res.status(201).json({ id: result.id });
  });
  api.get(
    '/incidents/:id',
    read((u, a, r) => incidentDetail(u, a, r.params.id.toUpperCase())),
  );
  api.get(
    '/incidents/:id/recommendations',
    read(async (u, a, r) => recommendations(u, await accessIncident(u, a, r.params.id.toUpperCase())), {
      admin: true,
    }),
  );
  api.get(
    '/incidents/:id/resolutions',
    read((u, a, r) => resolutions(u, a, r.params.id.toUpperCase()), { technician: true }),
  );
  api.post(
    '/incidents/:id/actions/:action',
    change(async (u, a, r, b) => ({
      id: (await act(u, a, r.params.id.toUpperCase(), r.params.action, b)).id,
    })),
  );
  api.get('/workload', read(technicianWorkload, { technician: true }));
  api.patch(
    '/workload',
    change(async (u, a, r, b) => {
      role(a, 'TECHNICIAN');
      const available = boolean(b.available, 'Availability');
      await u.users.update({ _id: a.id }, { $set: { available } });
      u.afterCommit(() => u.live.dashboardChanged());
      return { ...a.publicProfile(), available };
    }),
  );

  api.get(
    '/notifications',
    read(async (u, a, r) => {
      const { page, size, skip } = paging(r.query);
      const filter = { recipientId: a.id };
      const rows = await u.notifications.find(filter, {
        sort: { createdAt: -1, _id: -1 },
        limit: size,
        skip,
      });
      const total = await u.notifications.count(filter),
        unread = await u.notifications.count({ ...filter, read: false });
      return { rows, total, unread, page, size };
    }),
  );
  api.get(
    '/notifications/unread',
    read(async (u, a) => ({ unread: await u.notifications.count({ recipientId: a.id, read: false }) })),
  );
  api.patch(
    '/notifications/read-all',
    change(async (u, a) => {
      await u.notifications.updateMany({ recipientId: a.id, read: false }, { $set: { read: true } });
      u.afterCommit(() => u.live.inboxChanged(a.id));
    }),
  );
  api.patch(
    '/notifications/:id/read',
    change(async (u, a, r) => {
      const result = await u.notifications.update(
        { _id: r.params.id, recipientId: a.id },
        { $set: { read: true } },
      );
      requireThat(result.matchedCount, 'Notification could not be found.', 404);
      u.afterCommit(() => u.live.inboxChanged(a.id));
    }),
  );

  api.get(
    '/admin/dashboard',
    read((u) => dashboard(u, timeZone), { admin: true }),
  );
  api.get(
    '/admin/violations',
    read((u, a, r) => findingsList(u, r.query), { admin: true }),
  );
  api.get(
    '/admin/outbox',
    read((u, a, r) => outbox(u, r.query), { admin: true }),
  );
  api.get('/admin/report.csv', async (req, res) => {
    const { unit, actor } = await actorRead(req);
    role(actor, 'ADMINISTRATOR');
    res.attachment('nexora-incidents.csv');
    res.type('text/csv; charset=utf-8');
    await pipeline(Readable.from(incidentCsv(unit)), res);
  });
  api.get(
    '/admin/audit',
    read(
      async (u, a, r) => {
        const { page, size, skip } = paging(r.query);
        const id = text(r.query.id, 'Incident ID', 0, 80).toUpperCase(),
          filter = id ? { incidentId: id } : {};
        const rows = await u.audit.find(filter, {
          sort: { timestamp: 1, _id: 1 },
          limit: size,
          skip,
          collation: { locale: 'en', numericOrdering: true },
        });
        return { rows, total: await u.audit.count(filter), page, size };
      },
      { admin: true },
    ),
  );
  api.get(
    '/admin/users',
    read(
      async (u, a, r) => {
        const { page, size, skip } = paging(r.query);
        const rows = await u.users.find(
          {},
          {
            sort: { _id: 1 },
            limit: size,
            skip,
            projection: { passwordHash: 0, authVersion: 0, googleSub: 0, activeLoad: 0 },
          },
        );
        return { rows, total: await u.users.count(), page, size };
      },
      { admin: true },
    ),
  );
  api.post('/admin/users', async (req, res) => {
    const { actor } = await actorRead(req);
    role(actor, 'ADMINISTRATOR');
    const key = sessionKey(req),
      input = data(req);
    const prepared = await prepareUser(input, input.role, companyDomain);
    const user = await repo.change(async (unit) => {
      role(await authenticated(unit, key), 'ADMINISTRATOR');
      return createUser(unit, prepared);
    });
    res.status(201).json(user.publicProfile());
  });
  api.patch(
    '/admin/users/:id',
    change(async (u, a, r, b) => {
      const user = await manageUser(u, a, r.params.id, b);
      if (b.active === false) u.afterCommit(() => u.live.disconnect(user.id));
      u.afterCommit(() => u.live.dashboardChanged());
      return user;
    }),
  );
  for (const [resource, save] of [
    ['services', saveService],
    ['policies', savePolicy],
    ['categories', saveCategory],
  ]) {
    api.post(
      '/admin/' + resource,
      change((u, a, r, b) => save(u, a, null, b), 201),
    );
    api.patch(
      '/admin/' + resource + '/:id',
      change((u, a, r, b) => save(u, a, r.params.id, b)),
    );
  }
  for (const name of ['services', 'categories']) {
    api.delete(
      '/admin/' + name + '/:id',
      change((u, a, r) => deleteCatalogItem(u, a, name, r.params.id)),
    );
  }
  api.post(
    '/admin/policies/:id/default',
    change(async (u, a, r) => {
      role(a, 'ADMINISTRATOR');
      const policy = await u.policies.get(r.params.id);
      await u.settingsRepository.update({ _id: 'global' }, { $set: { defaultPolicyId: policy.id } });
    }),
  );
  api.get(
    '/admin/settings',
    read((u) => settingsView(u.settings), { admin: true }),
  );
  api.patch(
    '/admin/settings',
    change(async (u, a, r, b) => {
      const saved = await configure(u, a, b);
      u.afterCommit(() => u.live.dashboardChanged());
      return settingsView(saved);
    }),
  );
  api.post('/admin/clock', async (req, res) => {
    requireThat(demoMode, 'The simulated clock is available in demo mode only.', 403);
    const { actor } = await actorRead(req);
    role(actor, 'ADMINISTRATOR');
    const body = data(req),
      key = sessionKey(req);
    const settings = await repo.change(async (unit) => {
      role(await authenticated(unit, key), 'ADMINISTRATOR');
      const updated = await unit.settingsRepository.findAndUpdate(
        { _id: 'global' },
        body.reset === true
          ? { $set: { clockOffsetMinutes: 0 } }
          : { $inc: { clockOffsetMinutes: integer(body.minutes, 'Minutes', 1, 60) } },
      );
      unit.afterCommit(() => unit.live.dashboardChanged());
      return updated;
    });
    if (body.reset !== true) await monitor(repo);
    res.json(settingsView(settings));
  });
  api.post('/admin/monitor', async (req, res) => {
    const { actor } = await actorRead(req);
    role(actor, 'ADMINISTRATOR');
    res.json({ log: await monitor(repo) });
  });

  api.use(() => {
    throw new Problem(404, 'This API route could not be found.');
  });
  app.use(express.static(dist, { index: false, etag: true, maxAge: 0 }));
  app.get(['/', '/login', '/dashboard'], (req, res) => res.sendFile(join(dist, 'index.html')));
  app.get('/health', async (req, res) => {
    await repo.ping();
    res.type('text').send('OK\n');
  });
  app.use(() => {
    throw new Problem(404, 'This page could not be found.');
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof Problem) {
      if (err.status === 429) res.set('Retry-After', '300');
      return res.status(err.status).json({ message: err.message, ...err.details });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON.' });
    if (err.type === 'entity.too.large')
      return res.status(413).json({ message: 'The request is too large.' });
    if (err.code === 11000)
      return res.status(409).json({ message: 'A record with this ID or e-mail already exists.' });
    console.error('Request failed', req.method, err.name, err.code || '');
    res.status(500).json({ message: 'The request could not be completed.' });
  });
  return app;
}
