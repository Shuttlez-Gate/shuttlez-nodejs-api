import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDir = path.join(root, '.local', 'pg-test');
const dataDir = path.join(localDir, 'data');
const passwordFile = path.join(localDir, 'password');
const markerFile = path.join(localDir, 'cluster.json');
const port = 54329;
const user = 'shuttlez_test';
const database = 'shuttlez_integration_test';

mkdirSync(localDir, { recursive: true });
const password = existsSync(passwordFile)
  ? readFileSync(passwordFile, 'utf8').trim()
  : randomBytes(24).toString('hex');
if (!existsSync(passwordFile)) writeFileSync(passwordFile, password, { encoding: 'utf8' });

function redact(value) {
  return String(value ?? '').split(password).join('[redacted]');
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  onLog: () => {},
  onError: (error) => {
    process.stderr.write(`${redact(error)}\n`);
  },
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  await pg.initialise();
}
await pg.start();

const admin = pg.getPgClient('postgres');
await admin.connect();
const identity = await admin.query(
  'SELECT current_database() AS db, inet_server_port() AS port, version() AS version',
);
const row = identity.rows[0];
if (Number(row.port) !== port) {
  throw new Error(`Refusing to continue: server port is ${row.port}, expected ${port}`);
}
const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (existing.rowCount === 0) {
  await admin.query(
    `CREATE DATABASE ${admin.escapeIdentifier(database)} WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
  );
}
await admin.end();

const client = pg.getPgClient(database);
await client.connect();
const encoding = await client.query(
  `SELECT pg_encoding_to_char(encoding) AS encoding
   FROM pg_database
   WHERE datname = current_database()`,
);
if (encoding.rows[0]?.encoding !== 'UTF8') {
  await client.end();
  throw new Error(
    `Refusing to use ${database}: encoding is ${encoding.rows[0]?.encoding}, expected UTF8`,
  );
}
const tables = await client.query(
  `SELECT c.relname AS name
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY 1`,
);
const names = tables.rows.map((item) => item.name);
const ownedByUs = existsSync(markerFile);
if (names.length > 0 && !names.includes('RideRequestsSet') && !ownedByUs) {
  throw new Error(
    `Refusing to initialize ${database}: public schema already has ${names.length} tables and is not this test cluster`,
  );
}
await client.end();

if (!names.includes('RideRequestsSet')) {
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
  const child = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
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
  process.stdout.write(redact(output));
  if (code !== 0) {
    throw new Error(`prisma db push exited ${code}`);
  }
}

const verify = pg.getPgClient(database);
await verify.connect();
const after = await verify.query(
  `SELECT COUNT(*)::int AS tables
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'`,
);
const required = await verify.query(
  `SELECT c.relname AS name
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = ANY($1::text[])`,
  [['UsersSet', 'DriversSet', 'RideRequestsSet', 'TripsSet', 'BookingsSet', 'SupportMessagesSet']],
);
await verify.query('CREATE TABLE IF NOT EXISTS "_shuttlez_test_probe" (id int primary key)');
await verify.query('INSERT INTO "_shuttlez_test_probe" (id) VALUES (1) ON CONFLICT DO NOTHING');
const probe = await verify.query('SELECT id FROM "_shuttlez_test_probe" WHERE id = 1');
await verify.query('DROP TABLE "_shuttlez_test_probe"');
await verify.end();

writeFileSync(
  markerFile,
  JSON.stringify({
    port,
    user,
    database,
    host: '127.0.0.1',
    createdBy: 'scripts/start-integration-postgres.mjs',
  }),
  { encoding: 'utf8' },
);
const urlFile = path.join(localDir, 'database-url');
writeFileSync(
  urlFile,
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`,
  { encoding: 'utf8' },
);

const slotScript = spawn(process.execPath, [path.join(root, 'scripts', 'apply-captain-trip-slot.mjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let slotOutput = '';
slotScript.stdout.on('data', (chunk) => {
  slotOutput += chunk.toString();
});
slotScript.stderr.on('data', (chunk) => {
  slotOutput += chunk.toString();
});
const slotCode = await new Promise((resolve) => slotScript.on('close', resolve));
process.stdout.write(redact(slotOutput));
if (slotCode !== 0) {
  throw new Error(`captain trip slot script exited ${slotCode}`);
}

process.stdout.write(
  [
    `host=127.0.0.1`,
    `port=${port}`,
    `database=${database}`,
    `serverDatabase=${row.db}`,
    `tables=${after.rows[0].tables}`,
    `required=${required.rows.map((item) => item.name).sort().join(',')}`,
    `probe=${probe.rowCount}`,
    `version=${String(row.version).split(',')[0]}`,
    `tablesBeforePush=${names.length}`,
  ].join('\n') + '\n',
);
