import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

/** Hash of a non-credential. Keeps a missing account on the same scrypt path. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$222ebbc784c9c09b5d4f036d24f9c4ed$e743e56c3b2314d1bc19083705ffa1253a988cb09bef47167dddaff479500e7a';

export function isAdminPasswordShape(password: string): boolean {
  if (password.length < 10 || password.length > 128) return false;
  return hasPasswordClasses(password);
}

/** Rider passwords: 8–128 characters, at least one letter and one digit. */
export function isRiderPasswordShape(password: string): boolean {
  if (password.length < 8 || password.length > 128) return false;
  return hasPasswordClasses(password);
}

function hasPasswordClasses(password: string): boolean {
  const hasLetter = /[A-Za-z\u0600-\u06FF]/.test(password);
  const hasDigit = /\d/.test(password);
  return hasLetter && hasDigit;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptKey(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [scheme, n, r, p, saltHex, hashHex] = parts;
  if (scheme !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1') return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await scryptKey(password, salt);
  return timingSafeEqual(actual, expected);
}

export async function passwordMatches(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const candidate =
    stored && stored.startsWith('scrypt$16384$8$1$') ? stored : DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(password, candidate);
  return Boolean(stored) && stored === candidate && ok;
}
