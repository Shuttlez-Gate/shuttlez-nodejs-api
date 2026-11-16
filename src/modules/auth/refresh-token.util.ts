import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma/prisma.service';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type RefreshRow = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  revokedAt: Date | null;
  deviceId: string | null;
  platform: string | null;
};

export async function findStoredRefreshToken(
  prisma: PrismaService,
  presented: string,
): Promise<RefreshRow | null> {
  const hashed = hashRefreshToken(presented);
  const byHash = await prisma.refreshToken.findFirst({ where: { token: hashed } });
  if (byHash) return byHash;
  if (presented === hashed) return null;
  return prisma.refreshToken.findFirst({ where: { token: presented } });
}
