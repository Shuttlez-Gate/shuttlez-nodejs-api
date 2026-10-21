import { PrismaService } from '../../database/prisma/prisma.service';

export type RiderHistoryProduct = 'trip' | 'ride' | 'group';

export type RiderHistoryChange = {
  userId: string;
  product: RiderHistoryProduct;
  id: string;
};

type Handler = (change: RiderHistoryChange) => void;
const handlers = new Set<Handler>();

export function onRiderHistoryChange(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function publishRiderHistoryChange(change: RiderHistoryChange): void {
  const userId = change.userId.trim();
  const id = change.id.trim();
  if (!userId || !id) return;
  for (const handler of handlers) {
    handler({ ...change, userId, id });
  }
}

export async function publishTripRiders(
  prisma: PrismaService,
  tripId: string,
): Promise<void> {
  const bookings = await prisma.booking.findMany({
    where: { tripId, isDeleted: false },
    select: { userId: true },
  });
  const seen = new Set<string>();
  for (const booking of bookings) {
    if (seen.has(booking.userId)) continue;
    seen.add(booking.userId);
    publishRiderHistoryChange({
      userId: booking.userId,
      product: 'trip',
      id: tripId,
    });
  }
}

export async function publishGroupRiders(
  prisma: PrismaService,
  groupId: string,
  organizerUserId: string,
): Promise<void> {
  const members = await prisma.groupMember.findMany({
    where: { groupRequestId: groupId, isDeleted: false },
    select: { userId: true },
  });
  const seen = new Set<string>();
  if (organizerUserId) seen.add(organizerUserId);
  for (const member of members) seen.add(member.userId);
  for (const userId of seen) {
    publishRiderHistoryChange({ userId, product: 'group', id: groupId });
  }
}
