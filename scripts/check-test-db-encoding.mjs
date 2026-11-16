import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = readFileSync(path.join(root, '.local', 'pg-test', 'database-url'), 'utf8').trim();
const prisma = new PrismaClient({ datasources: { db: { url } } });
const rows = await prisma.$queryRawUnsafe(`
  SELECT current_database() AS db,
         inet_server_port() AS port,
         current_setting('server_encoding') AS server_encoding,
         current_setting('client_encoding') AS client_encoding,
         pg_encoding_to_char(encoding) AS database_encoding
  FROM pg_database
  WHERE datname = current_database()
`);
const counts = await prisma.$queryRawUnsafe(`
  SELECT
    (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
    (SELECT COUNT(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e') AS enums,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE contype = 'f') AS foreign_keys,
    (SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes
`);
console.log(JSON.stringify({ connection: rows, counts }));
await prisma.$disconnect();
