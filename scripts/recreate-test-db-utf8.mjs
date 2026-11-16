import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = 'shuttlez_integration_test';
const source = new URL(readFileSync(path.join(root, '.local', 'pg-test', 'database-url'), 'utf8').trim());
if (source.hostname !== '127.0.0.1' || source.port !== '54329' || source.pathname !== `/${database}`) {
  throw new Error('Refusing to recreate: URL is not the isolated test database');
}

const adminUrl = new URL(source.toString());
adminUrl.pathname = '/postgres';
adminUrl.search = '';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const identity = await admin.query(
  'SELECT current_database() AS db, inet_server_port() AS port',
);
if (identity.rows[0]?.db !== 'postgres' || Number(identity.rows[0]?.port) !== 54329) {
  await admin.end();
  throw new Error('Refusing to recreate: admin connection is not the local test server');
}
const current = await admin.query(
  'SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1',
  [database],
);
if (current.rowCount !== 1) {
  await admin.end();
  throw new Error('Refusing to recreate: target database was not found');
}
if (current.rows[0].encoding === 'UTF8') {
  console.log('encoding=UTF8');
  await admin.end();
  process.exit(0);
}

await admin.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
  [database],
);
await admin.query('DROP DATABASE "shuttlez_integration_test"');
await admin.query(
  `CREATE DATABASE "shuttlez_integration_test" WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
);
await admin.end();

const child = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL: source.toString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});
const code = await new Promise((resolve) => child.on('close', resolve));
const password = decodeURIComponent(source.password);
process.stdout.write(output.split(password).join('[redacted]'));
if (code !== 0) {
  throw new Error(`prisma db push exited ${code}`);
}

const check = new pg.Client({ connectionString: source.toString() });
await check.connect();
const verified = await check.query(`
  SELECT current_database() AS db,
         inet_server_port() AS port,
         current_setting('server_encoding') AS encoding
`);
if (verified.rows[0]?.db !== database || Number(verified.rows[0]?.port) !== 54329) {
  await check.end();
  throw new Error('Refusing to probe: connection is not the recreated test database');
}
await check.query('CREATE TABLE "_encoding_probe" (id int primary key, note text)');
await check.query(`INSERT INTO "_encoding_probe" (id, note) VALUES (1, 'رسالة')`);
const probe = await check.query('SELECT note FROM "_encoding_probe" WHERE id = 1');
await check.query('DROP TABLE "_encoding_probe"');
await check.end();
console.log(
  `db=${verified.rows[0].db} port=${verified.rows[0].port} encoding=${verified.rows[0].encoding} probe=${probe.rows[0]?.note}`,
);
