import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { connectDatabase } from '../server/database.js';
import { createApp } from '../server/http.js';
import { startLocalMongo } from '../server/local-mongo.js';

async function listen(server) {
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((done, fail) => {
    server.close((error) => (error ? fail(error) : done()));
    server.closeAllConnections();
  });
}

export async function databaseProcess() {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'nexora-test-'));
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  let mongo;

  async function cleanDirectory() {
    const absolute = await realpath(directory);
    assert.equal(dirname(absolute), parent);
    assert(basename(absolute).startsWith('nexora-test-'));
    await rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }

  try {
    mongo = await startLocalMongo(directory, port);
  } catch (error) {
    await cleanDirectory();
    throw error;
  }
  return {
    get uri() {
      return mongo.uri;
    },
    async restart() {
      await mongo.stop();
      mongo = await startLocalMongo(directory, port);
    },
    async close() {
      await mongo.stop();
      await cleanDirectory();
    },
  };
}

export async function fixture(t, process, options = {}) {
  const name = 'nexora_test_' + randomUUID().replaceAll('-', '');
  const { databaseOptions = { demoMode: true }, beforeConnect, ...appOptions } = options;
  if (beforeConnect) await examine(process.uri, name, beforeConnect);
  const repo = await connectDatabase(process.uri, name, databaseOptions);
  const server = createServer();
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      await close(server);
    } finally {
      await repo.close();
    }
  }
  t.after(stop);
  const port = await listen(server);
  const origin = 'http://127.0.0.1:' + port;
  server.on('request', createApp(repo, { port, dist: resolve('dist'), demoMode: true, ...appOptions }));

  return {
    repo,
    name,
    origin,
    stop,
    client: () => browser(origin),
    async raw(operation) {
      return examine(process.uri, name, operation);
    },
  };
}

export async function examine(uri, name, operation) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    return await operation(client.db(name));
  } finally {
    await client.close();
  }
}

export function browser(base) {
  const cookies = new Map();
  async function raw(path, options = {}) {
    const { method = 'GET', body, headers = {}, signal = AbortSignal.timeout(8000) } = options;
    const auth = cookies.size ? { cookie: [...cookies.values()].join('; ') } : {};
    const writes = ['POST', 'PATCH', 'DELETE'].includes(method);
    const defaults = writes ? { origin: base, 'content-type': 'application/json' } : {};
    const response = await fetch(base + '/api' + path, {
      method,
      signal,
      redirect: 'manual',
      headers: { ...defaults, ...auth, ...headers },
      body: writes ? JSON.stringify(body ?? {}) : undefined,
    });
    for (const entry of response.headers.getSetCookie()) {
      const cookie = entry.split(';')[0];
      const key = cookie.slice(0, cookie.indexOf('='));
      if (cookie.endsWith('=')) cookies.delete(key);
      else cookies.set(key, cookie);
    }
    return response;
  }

  const api = async (path, options = {}) => {
    const response = await raw(path, options);
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : await response.text();
    assert.equal(
      response.status,
      options.expect ?? 200,
      (options.method ?? 'GET') + ' ' + path + (data?.message ? ' — ' + data.message : ''),
    );
    return data;
  };
  api.raw = raw;
  return api;
}

// Raw HTTP sets the public Host while talking to a local reverse-proxy upstream.
export async function upstream(origin, path, headers, body) {
  return new Promise((done, fail) => {
    const req = request(
      origin + '/api' + path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        timeout: 8000,
      },
      (response) => {
        response.resume();
        response.on('end', () => done(response));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Local upstream request timed out.')));
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

export const samples = {
  employee: ['ravi', 'Emp@1234'],
  outsider: ['sara', 'Emp@1234'],
  admin: ['manager', 'Admin@123'],
  technician: ['arjun', 'Tech@1234'],
};

export async function signIn(api, [email, password]) {
  return api('/auth/login', { method: 'POST', body: { email, password } });
}

export async function signedIn(f, kind) {
  const api = f.client();
  const user = await signIn(api, samples[kind]);
  return { api, user };
}

export function incidentInput(overrides = {}) {
  return {
    title: 'Terminal label inverted',
    description:
      'The terminal onboarding labels look inverted after a rotation at the training station.',
    service: 'SVC1',
    category: 'Application',
    impact: 'HIGH',
    urgency: 'HIGH',
    affectedUsers: 200,
    requestId: randomUUID(),
    ...overrides,
  };
}

export async function report(api, body = incidentInput()) {
  const { id } = await api('/incidents', { method: 'POST', body, expect: 201 });
  return api('/incidents/' + id);
}

export const act = (api, id, action, body = {}, expect = 200) =>
  api('/incidents/' + id + '/actions/' + action, {
    method: 'POST',
    body,
    expect,
  });

export async function assignedTechnician(f, incident) {
  const { api: admin } = await signedIn(f, 'admin');
  const { rows } = await admin('/admin/users');
  const assignee = rows.find((user) => user.id === incident.assignedTo);
  assert(assignee, 'Expected an assigned technician');
  const api = f.client();
  await signIn(api, [assignee.email, 'Tech@1234']);
  return api;
}

export async function investigate(api, incident) {
  await act(api, incident.id, 'acknowledge');
  await act(api, incident.id, 'investigate');
}
