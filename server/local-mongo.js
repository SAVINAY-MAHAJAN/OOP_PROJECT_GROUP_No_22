import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { MongoClient } from 'mongodb';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function startLocalMongo(directory, port) {
  // A stable port and dbPath keep the replica-set member and its WiredTiger data usable on restart.
  await mkdir(directory, { recursive: true });
  const binary = process.platform === 'win32' && process.arch === 'arm64' ? { arch: 'x64' } : {};
  const name = 'nexora',
    host = '127.0.0.1:' + port;
  const server = await MongoMemoryServer.create({
    binary,
    instance: {
      port,
      portGeneration: false,
      ip: '127.0.0.1',
      replSet: name,
      dbPath: resolve(directory),
      storageEngine: 'wiredTiger',
      launchTimeout: 20000,
      args: ['--wiredTigerCacheSizeGB', '0.25'],
    },
  });
  const uri = server.getUri('nexora_servicedesk', '127.0.0.1') + '?replicaSet=' + name;
  const direct = new MongoClient(server.getUri('admin', '127.0.0.1'), {
    directConnection: true,
    serverSelectionTimeoutMS: 8000,
  });
  const stop = () => server.stop({ doCleanup: false, force: false });
  try {
    const admin = direct.db('admin');
    try {
      const { config } = await admin.command({ replSetGetConfig: 1 });
      if (config.members[0].host !== host)
        throw new Error(
          'Use the original MONGO_PORT for this data directory, or choose a separate DATA_DIR.',
        );
    } catch (error) {
      if (error.code !== 94) throw error;
      await admin.command({ replSetInitiate: { _id: name, members: [{ _id: 0, host }] } });
    }
    const primary = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    try {
      await primary.db().command({ ping: 1 });
    } finally {
      await primary.close();
    }
    return { uri, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    await direct.close();
  }
}
