import { readFileSync } from 'fs';
import pg from 'pg';

function loadEnv() {
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split <= 0 || line.startsWith('#')) continue;
    const key = line.slice(0, split).trim();
    if (!process.env[key]) process.env[key] = line.slice(split + 1).trim();
  }
}

loadEnv();
const url = new URL(process.env.DATABASE_URL);
const db = url.pathname.replace(/^\//, '');
if (db === 'neondb') {
  console.error('refusing production database');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const names = [
  'SubscriptionPackagesSet',
  'PackagePurchasesSet',
  'UserSubscriptionsSet',
  'PackagePaymentAuditsSet',
  'RidePackageReservationsSet',
  'RoutesSet',
  'BookingsSet',
  'UsersSet',
];
const tables = await client.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
  [names],
);
const columns = await client.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'SubscriptionPackagesSet'`,
);
console.log(JSON.stringify({
  host: url.hostname,
  db,
  tables: tables.rows.map((row) => row.table_name),
  packageColumns: columns.rows.map((row) => row.column_name),
}, null, 2));

if (process.argv.includes('--apply')) {
  if (db !== 'shuttlez_integration_test') {
    console.error('refusing apply outside integration database');
    process.exit(1);
  }
  const sql = readFileSync(new URL('../prisma/sql/20261120_route_packages_instapay.sql', import.meta.url), 'utf8');
  await client.query(sql);
  const after = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [names],
  );
  console.log(JSON.stringify({ applied: true, tables: after.rows.map((row) => row.table_name) }));
}

await client.end();
