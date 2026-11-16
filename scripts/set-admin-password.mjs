import { randomBytes, scrypt } from 'crypto';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

function databaseUrlFromFile() {
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('DATABASE_URL=')) continue;
    let value = line.slice('DATABASE_URL='.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  throw new Error('DATABASE_URL missing');
}

function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function normalizePhone(phone) {
  const digits = [...phone].filter((ch) => ch >= '0' && ch <= '9').join('');
  if (digits.startsWith('20') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+20${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `+20${digits}`;
  const trimmed = phone.trim();
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

function passwordShapeOk(password) {
  return (
    password.length >= 10 &&
    password.length <= 128 &&
    /[A-Za-z\u0600-\u06FF]/.test(password) &&
    /\d/.test(password)
  );
}

const url = databaseUrlFromFile();
const name = databaseName(url);
if (!name || name === 'neondb') {
  console.error('refused: this script does not change the production database');
  process.exit(1);
}
if (name !== 'shuttlez_integration_test') {
  console.error('refused: unexpected database name');
  process.exit(1);
}

const phoneRaw = process.env.ADMIN_PHONE ?? '';
const password = process.env.ADMIN_PASSWORD ?? '';
if (!phoneRaw || !password) {
  console.error('Set ADMIN_PHONE and ADMIN_PASSWORD. They are not printed.');
  process.exit(1);
}
if (!passwordShapeOk(password)) {
  console.error('Password must be 10-128 characters and include a letter and a digit.');
  process.exit(1);
}

const phone = normalizePhone(phoneRaw);
const salt = randomBytes(16);
const derived = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
const passwordHash = `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;

process.env.DATABASE_URL = url;
const prisma = new PrismaClient();
try {
  const user = await prisma.user.findFirst({
    where: { phone, isDeleted: false, userType: 3, isActive: true },
    select: { id: true },
  });
  if (!user) {
    console.error('no active admin for that phone');
    process.exit(1);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, updatedAt: new Date() },
  });
  console.log(`admin password updated for phone ending ${phone.slice(-4)}`);
} finally {
  await prisma.$disconnect();
}
