import { readFileSync } from 'fs';
import { Client } from 'pg';

function databaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const line = text.split(/\r?\n/).find((row) => row.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL missing');
  return line.slice('DATABASE_URL='.length).trim();
}

function hostOf(url) {
  const parsed = new URL(url);
  return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, '') };
}

const statements = [
  {
    name: 'IX_TripsSet_Driver_Schedule',
    sql: `CREATE INDEX IF NOT EXISTS "IX_TripsSet_Driver_Schedule"
      ON "TripsSet" ("DriverId", "ScheduledAt" DESC, "Id" DESC)
      WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL`,
  },
  {
    name: 'IX_BookingsSet_User_Active',
    sql: `CREATE INDEX IF NOT EXISTS "IX_BookingsSet_User_Active"
      ON "BookingsSet" ("UserId", "TripId")
      WHERE "IsDeleted" = false`,
  },
  {
    name: 'IX_RideRequestsSet_Rider_Sort',
    sql: `CREATE INDEX IF NOT EXISTS "IX_RideRequestsSet_Rider_Sort"
      ON "RideRequestsSet" (
        "RiderUserId",
        (COALESCE("ScheduledFor", "StartedAt", "CreatedAt")) DESC,
        "Id" DESC
      )
      WHERE "IsDeleted" = false`,
  },
  {
    name: 'IX_RideRequestsSet_Driver_Sort',
    sql: `CREATE INDEX IF NOT EXISTS "IX_RideRequestsSet_Driver_Sort"
      ON "RideRequestsSet" (
        "DriverId",
        (COALESCE("ScheduledFor", "StartedAt", "CreatedAt")) DESC,
        "Id" DESC
      )
      WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL`,
  },
  {
    name: 'IX_GroupRequestsSet_Driver_Sort',
    sql: `CREATE INDEX IF NOT EXISTS "IX_GroupRequestsSet_Driver_Sort"
      ON "GroupRequestsSet" (
        "DriverId",
        (COALESCE("StartedAt", "CreatedAt")) DESC,
        "Id" DESC
      )
      WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL`,
  },
  {
    name: 'IX_GroupMembersSet_User_Active',
    sql: `CREATE INDEX IF NOT EXISTS "IX_GroupMembersSet_User_Active"
      ON "GroupMembersSet" ("UserId", "GroupRequestId")
      WHERE "IsDeleted" = false`,
  },
];

function planLines(rows) {
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function explain(client, label, sql, params) {
  const started = Date.now();
  const rows = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  return {
    label,
    ms: Date.now() - started,
    plan: planLines(rows.rows),
  };
}

async function main() {
  const url = databaseUrl();
  const identity = hostOf(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  const meta = await client.query(
    `SELECT current_database() AS db, current_setting('server_version') AS version`,
  );
  const db = meta.rows[0].db;
  console.log(JSON.stringify({
    provider: 'PostgreSQL',
    host: identity.host,
    database: db,
    version: meta.rows[0].version,
  }));
  if (db === 'neondb') {
    console.log('ABORT: connected database is neondb. Indexes were not created.');
    await client.end();
    process.exitCode = 2;
    return;
  }

  const indexes = await client.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN (
        'TripsSet', 'BookingsSet', 'RideRequestsSet',
        'GroupRequestsSet', 'GroupMembersSet'
      )
    ORDER BY tablename, indexname
  `);
  console.log('INDEXES');
  for (const row of indexes.rows) {
    console.log(`${row.tablename}\t${row.indexname}\t${row.indexdef}`);
  }

  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM "BookingsSet" WHERE "IsDeleted" = false) AS bookings,
      (SELECT count(*) FROM "TripsSet" WHERE "IsDeleted" = false) AS trips,
      (SELECT count(*) FROM "RideRequestsSet" WHERE "IsDeleted" = false) AS rides,
      (SELECT count(*) FROM "GroupRequestsSet" WHERE "IsDeleted" = false) AS groups,
      (SELECT count(*) FROM "GroupMembersSet" WHERE "IsDeleted" = false) AS members
  `);
  console.log('COUNTS', JSON.stringify(counts.rows[0]));

  const riders = await client.query(`
    SELECT "UserId"::text AS id, count(*)::int AS n
    FROM "BookingsSet"
    WHERE "IsDeleted" = false
    GROUP BY "UserId"
    ORDER BY n DESC
    LIMIT 3
  `);
  const captains = await client.query(`
    SELECT "DriverId"::text AS id, count(*)::int AS n
    FROM "TripsSet"
    WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL
    GROUP BY "DriverId"
    ORDER BY n DESC
    LIMIT 3
  `);
  console.log('TOP_RIDERS', JSON.stringify(riders.rows));
  console.log('TOP_CAPTAINS', JSON.stringify(captains.rows));

  const riderId = riders.rows[0]?.id;
  const captainId = captains.rows[0]?.id;
  const before = [];
  if (riderId) {
    before.push(await explain(client, 'rider-bookings', `
      SELECT b."TripId"::text AS id, t."ScheduledAt" AS sort_at
      FROM "BookingsSet" b
      INNER JOIN "TripsSet" t ON t."Id" = b."TripId" AND t."IsDeleted" = false
      WHERE b."UserId" = $1::uuid AND b."IsDeleted" = false
      ORDER BY t."ScheduledAt" DESC, t."Id" DESC
      LIMIT 10
    `, [riderId]));
  }
  if (captainId) {
    before.push(await explain(client, 'captain-trips', `
      SELECT t."Id"::text
      FROM "TripsSet" t
      WHERE t."DriverId" = $1::uuid AND t."IsDeleted" = false
      ORDER BY t."ScheduledAt" DESC, t."Id" DESC
      LIMIT 10
    `, [captainId]));
    before.push(await explain(client, 'captain-rides', `
      SELECT r."Id"::text
      FROM "RideRequestsSet" r
      WHERE r."DriverId" = $1::uuid AND r."IsDeleted" = false
      ORDER BY COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt") DESC, r."Id" DESC
      LIMIT 10
    `, [captainId]));
  }
  console.log('BEFORE');
  for (const item of before) {
    console.log(`--- ${item.label} clientMs=${item.ms}`);
    console.log(item.plan);
  }

  if (process.argv.includes('--apply') && db === 'shuttlez_integration_test') {
    for (const statement of statements) {
      const started = Date.now();
      await client.query(statement.sql);
      console.log(`APPLIED ${statement.name} ms=${Date.now() - started}`);
    }
    const after = [];
    if (riderId) {
      after.push(await explain(client, 'rider-bookings', `
        SELECT b."TripId"::text AS id, t."ScheduledAt" AS sort_at
        FROM "BookingsSet" b
        INNER JOIN "TripsSet" t ON t."Id" = b."TripId" AND t."IsDeleted" = false
        WHERE b."UserId" = $1::uuid AND b."IsDeleted" = false
        ORDER BY t."ScheduledAt" DESC, t."Id" DESC
        LIMIT 10
      `, [riderId]));
    }
    if (captainId) {
      after.push(await explain(client, 'captain-trips', `
        SELECT t."Id"::text
        FROM "TripsSet" t
        WHERE t."DriverId" = $1::uuid AND t."IsDeleted" = false
        ORDER BY t."ScheduledAt" DESC, t."Id" DESC
        LIMIT 10
      `, [captainId]));
      after.push(await explain(client, 'captain-rides', `
        SELECT r."Id"::text
        FROM "RideRequestsSet" r
        WHERE r."DriverId" = $1::uuid AND r."IsDeleted" = false
        ORDER BY COALESCE(r."ScheduledFor", r."StartedAt", r."CreatedAt") DESC, r."Id" DESC
        LIMIT 10
      `, [captainId]));
    }
    console.log('AFTER');
    for (const item of after) {
      console.log(`--- ${item.label} clientMs=${item.ms}`);
      console.log(item.plan);
    }
  } else {
    console.log('SKIP_APPLY');
  }
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'database check failed');
  process.exit(1);
});
