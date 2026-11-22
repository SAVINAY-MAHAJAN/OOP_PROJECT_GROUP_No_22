import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { connectDatabase } from './database.js';
import { createApp } from './http.js';
import { startLocalMongo } from './local-mongo.js';
import { monitor } from './sla/monitor.js';
import { integer, requireThat } from './validation.js';
import { readAppConfig } from './config.js';
import { prepareUser } from './accounts.js';

let server,
  repo,
  local,
  interval,
  monitoring,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  repo?.live.close();
  if (server?.listening) await new Promise((done) => server.close(done));
  await monitoring;
  await repo?.close();
  await local?.stop();
}
async function start() {
  const config = readAppConfig();
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  try {
    await access(resolve(dist, 'index.html'));
  } catch {
    throw new Error('Build the browser UI with npm run build before starting Nexora.');
  }
  let bootstrapAccount;
  if (!config.demoMode && (process.env.BOOTSTRAP_EMAIL || process.env.BOOTSTRAP_PASSWORD)) {
    requireThat(
      process.env.BOOTSTRAP_EMAIL && process.env.BOOTSTRAP_PASSWORD,
      'Set both BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD for initial setup.',
    );
    bootstrapAccount = await prepareUser(
      {
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
        name: 'Initial Administrator',
      },
      'ADMINISTRATOR',
      config.companyDomain,
    );
  }
  if (!process.env.MONGODB_URI) {
    const mongoPort = integer(process.env.MONGO_PORT || 27271, 'MongoDB port', 1024, 65535);
    local = await startLocalMongo(resolve(process.env.DATA_DIR || '.data', 'mongo'), mongoPort);
  }
  repo = await connectDatabase(
    process.env.MONGODB_URI || local.uri,
    process.env.MONGODB_DB || 'nexora_servicedesk',
    {
      demoMode: config.demoMode,
      companyDomain: config.companyDomain,
      bootstrapAccount,
    },
  );
  server = createServer(createApp(repo, { ...config, dist }));
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(config.port, config.host, done);
  });
  interval = setInterval(() => {
    if (monitoring) return;
    monitoring = monitor(repo)
      .catch((err) => console.error('SLA check failed', err.name, err.code || ''))
      .finally(() => {
        monitoring = null;
      });
  }, 30000);
  console.log(
    'Nexora ServiceDesk   ' + (config.publicOrigin || 'http://127.0.0.1:' + config.port) + '/login',
  );
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
}
try {
  await start();
} catch (error) {
  console.error(
    'Nexora could not start:',
    error.name === 'MongoServerSelectionError'
      ? 'Check the MongoDB connection and replica-set address.'
      : error.message,
  );
  await stop();
  process.exitCode = 1;
}
