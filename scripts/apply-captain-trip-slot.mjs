import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = 'shuttlez_integration_test';
const source = new URL(readFileSync(path.join(root, '.local', 'pg-test', 'database-url'), 'utf8').trim());
if (source.hostname !== '127.0.0.1' || source.port !== '54329' || source.pathname !== `/${database}`) {
  throw new Error('Refusing to apply: URL is not the isolated test database');
}

const sql = readFileSync(
  path.join(root, 'prisma', 'sql', '20261027_captain_trip_departure_slot.sql'),
  'utf8',
);

const client = new pg.Client({ connectionString: source.toString() });
await client.connect();
try {
  const identity = await client.query(
    'SELECT current_database() AS db, inet_server_port() AS port',
  );
  if (identity.rows[0]?.db !== database || Number(identity.rows[0]?.port) !== 54329) {
    throw new Error('Refusing to apply: connection is not the isolated test database');
  }
  await client.query(sql);
  const index = await client.query(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'UX_TripsSet_Route_DepartureSlot'`,
  );
  if (index.rowCount !== 1) {
    throw new Error('Departure slot unique index was not created');
  }
  console.log('index=UX_TripsSet_Route_DepartureSlot');
} finally {
  await client.end();
}
