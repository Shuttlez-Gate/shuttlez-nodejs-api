import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = 'shuttlez_integration_test';
const source = new URL(readFileSync(path.join(root, '.local', 'pg-test', 'database-url'), 'utf8').trim());
if (source.hostname !== '127.0.0.1' || source.port !== '54329' || source.pathname !== `/${database}`) {
  throw new Error('Refusing to inspect: URL is not the isolated test database');
}

const client = new pg.Client({ connectionString: source.toString() });
await client.connect();
const identity = await client.query(
  'SELECT current_database() AS db, inet_server_port() AS port',
);
if (identity.rows[0]?.db !== database || Number(identity.rows[0]?.port) !== 54329) {
  await client.end();
  throw new Error('Refusing to inspect: connection is not the isolated test database');
}

const duplicates = await client.query(`
  SELECT t."RouteId" AS route_id,
         to_char(t."ScheduledAt" AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS slot,
         COUNT(*)::int AS trips
  FROM "TripsSet" t
  JOIN "RoutesSet" r ON r."Id" = t."RouteId"
  WHERE t."IsDeleted" = false
    AND t."Status" <> 5
    AND r."OwnerType" = 1
  GROUP BY t."RouteId", slot
  HAVING COUNT(*) > 1
  ORDER BY trips DESC
`);
const totals = await client.query(`
  SELECT COUNT(*)::int AS captain_trips
  FROM "TripsSet" t
  JOIN "RoutesSet" r ON r."Id" = t."RouteId"
  WHERE r."OwnerType" = 1 AND t."IsDeleted" = false AND t."Status" <> 5
`);
console.log(JSON.stringify({
  captainTrips: totals.rows[0]?.captain_trips ?? 0,
  duplicateGroups: duplicates.rowCount,
  duplicates: duplicates.rows,
}));
await client.end();
