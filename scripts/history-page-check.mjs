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

function pageOf(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function audit(label, rows) {
  const pageSize = 10;
  const pages = [1, 2, 3].map((page) => pageOf(rows, page, pageSize));
  const seen = new Set();
  let duplicate = false;
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) duplicate = true;
      seen.add(row.id);
    }
  }
  const ordered = rows.every((row, index) => {
    if (index === 0) return true;
    const prev = rows[index - 1];
    if (prev.sort !== row.sort) return prev.sort > row.sort;
    return prev.id >= row.id;
  });
  const missing = rows.filter((row) => !seen.has(row.id)).map((row) => row.id);
  return {
    label,
    total: rows.length,
    pageLengths: pages.map((page) => page.length),
    page1: pages[0].map((row) => row.id),
    page2: pages[1].map((row) => row.id),
    page3: pages[2].map((row) => row.id),
    duplicate,
    ordered,
    covered: seen.size,
    missingAfterThreePages: rows.length > 30 ? missing.length : missing.length,
    hasNext: {
      1: 10 < rows.length,
      2: 20 < rows.length,
      3: 30 < rows.length,
    },
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  const db = await client.query('SELECT current_database() AS db');
  if (db.rows[0].db === 'neondb') {
    console.log('ABORT production');
    await client.end();
    return;
  }

  const riders = await client.query(`
    SELECT "UserId"::text AS id, count(*)::int AS n
    FROM "BookingsSet" WHERE "IsDeleted" = false
    GROUP BY 1 ORDER BY n DESC LIMIT 1
  `);
  const rideRiders = await client.query(`
    SELECT "RiderUserId"::text AS id, count(*)::int AS n
    FROM "RideRequestsSet" WHERE "IsDeleted" = false
    GROUP BY 1 ORDER BY n DESC LIMIT 3
  `);
  const captains = await client.query(`
    SELECT "DriverId"::text AS id, count(*)::int AS n
    FROM "TripsSet"
    WHERE "IsDeleted" = false AND "DriverId" IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT 1
  `);
  console.log('ACCOUNTS', JSON.stringify({
    bookingRider: riders.rows[0] ?? null,
    rideRiders: rideRiders.rows,
    captain: captains.rows[0] ?? null,
  }));

  const riderId = riders.rows[0]?.id;
  if (riderId) {
    const rows = await client.query(`
      SELECT DISTINCT ON (t."Id") t."Id"::text AS id, t."ScheduledAt" AS sort
      FROM "BookingsSet" b
      INNER JOIN "TripsSet" t ON t."Id" = b."TripId" AND t."IsDeleted" = false
      WHERE b."UserId" = $1::uuid AND b."IsDeleted" = false
      ORDER BY t."Id", b."CreatedAt" DESC
    `, [riderId]);
    const sorted = rows.rows
      .map((row) => ({ id: row.id, sort: new Date(row.sort).getTime() }))
      .sort((a, b) => b.sort - a.sort || (a.id < b.id ? 1 : -1));
    console.log('RIDER_BOOKINGS', JSON.stringify(audit('rider-bookings', sorted)));
  }

  const busiestRider = rideRiders.rows[0]?.id;
  if (busiestRider) {
    const rows = await client.query(`
      SELECT "Id"::text AS id,
             COALESCE("ScheduledFor", "StartedAt", "CreatedAt") AS sort,
             "Status" AS status
      FROM "RideRequestsSet"
      WHERE "RiderUserId" = $1::uuid AND "IsDeleted" = false
    `, [busiestRider]);
    const sorted = rows.rows
      .map((row) => ({ id: row.id, sort: new Date(row.sort).getTime(), status: row.status }))
      .sort((a, b) => b.sort - a.sort || (a.id < b.id ? 1 : -1));
    const past = sorted.filter((row) => row.status === 4 || row.status === 5);
    const stranger = await client.query(`
      SELECT count(*)::int AS n FROM "RideRequestsSet"
      WHERE "RiderUserId" = $1::uuid AND "IsDeleted" = false
    `, ['00000000-0000-0000-0000-000000000000']);
    console.log('RIDER_RIDES', JSON.stringify({
      ...audit('rider-rides', sorted),
      completedOrCancelled: past.length,
      strangerCount: stranger.rows[0].n,
    }));
  }

  const captainId = captains.rows[0]?.id;
  if (captainId) {
    const rows = await client.query(`
      SELECT "Id"::text AS id, "ScheduledAt" AS sort, "Status" AS status
      FROM "TripsSet"
      WHERE "DriverId" = $1::uuid AND "IsDeleted" = false
    `, [captainId]);
    const sorted = rows.rows
      .map((row) => ({ id: row.id, sort: new Date(row.sort).getTime(), status: row.status }))
      .sort((a, b) => b.sort - a.sort || (a.id < b.id ? 1 : -1));
    const other = await client.query(`
      SELECT count(*)::int AS n FROM "TripsSet"
      WHERE "DriverId" IS DISTINCT FROM $1::uuid AND "IsDeleted" = false
    `, [captainId]);
    console.log('CAPTAIN_TRIPS', JSON.stringify({
      ...audit('captain-trips', sorted),
      otherDrivers: other.rows[0].n,
      finished: sorted.filter((row) => row.status === 4).length,
      cancelled: sorted.filter((row) => row.status === 5).length,
    }));
  }
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'page check failed');
  process.exit(1);
});
