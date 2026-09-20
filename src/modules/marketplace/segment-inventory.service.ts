import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import {
  consecutiveSegmentKeys,
  type OrderedStop,
} from './segment-occupancy';

type Tx = Prisma.TransactionClient;

@Injectable()
export class SegmentInventoryService {
  async createForTrip(
    tx: Tx,
    tripId: string,
    stops: OrderedStop[],
    capacity: number,
  ): Promise<void> {
    const sorted = [...stops].sort((a, b) => a.order - b.order);
    if (sorted.length < 2) {
      throw new AppException(
        'المسار يحتاج محطتين على الأقل',
        400,
        ErrorCodes.InvalidStops,
      );
    }
    const now = utcNow();
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const from = sorted[i];
      const to = sorted[i + 1];
      await tx.tripSegmentInventory.create({
        data: {
          id: newId(),
          tripId,
          fromStopId: from.id,
          toStopId: to.id,
          fromOrder: from.order,
          toOrder: to.order,
          capacity,
          remainingSeats: capacity,
          ...baseFields(now),
        },
      });
    }
  }

  async replaceForTrip(
    tx: Tx,
    tripId: string,
    stops: OrderedStop[],
    capacity: number,
  ): Promise<void> {
    await tx.tripSegmentInventory.updateMany({
      where: { tripId, isDeleted: false },
      data: { isDeleted: true, updatedAt: utcNow() },
    });
    await this.createForTrip(tx, tripId, stops, capacity);
  }

  async tryDecrementRange(
    tx: Tx,
    tripId: string,
    fromOrder: number,
    toOrder: number,
    seatCount: number,
  ): Promise<void> {
    const keys = consecutiveSegmentKeys(fromOrder, toOrder);
    if (keys.length === 0) {
      throw new AppException('المحطات غير صالحة للحجز', 400, ErrorCodes.InvalidStops);
    }
    for (const key of keys) {
      const updated = await tx.$executeRaw`
        UPDATE "TripSegmentInventorySet"
        SET "RemainingSeats" = "RemainingSeats" - ${seatCount},
            "UpdatedAt" = NOW()
        WHERE "TripId" = ${tripId}::uuid
          AND "IsDeleted" = false
          AND "FromOrder" = ${key.fromOrder}
          AND "ToOrder" = ${key.toOrder}
          AND "RemainingSeats" >= ${seatCount}`;
      if (Number(updated) === 0) {
        throw new AppException(
          'لا توجد مقاعد كافية على هذا الجزء من المسار',
          400,
          ErrorCodes.SeatUnavailable,
        );
      }
    }
  }

  async tryIncrementRange(
    tx: Tx,
    tripId: string,
    fromOrder: number,
    toOrder: number,
    seatCount: number,
  ): Promise<void> {
    const keys = consecutiveSegmentKeys(fromOrder, toOrder);
    for (const key of keys) {
      await tx.$executeRaw`
        UPDATE "TripSegmentInventorySet"
        SET "RemainingSeats" = "RemainingSeats" + ${seatCount},
            "UpdatedAt" = NOW()
        WHERE "TripId" = ${tripId}::uuid
          AND "IsDeleted" = false
          AND "FromOrder" = ${key.fromOrder}
          AND "ToOrder" = ${key.toOrder}`;
    }
  }

  async syncTripAvailableSeats(tx: Tx, tripId: string): Promise<number> {
    const rows = await tx.tripSegmentInventory.findMany({
      where: { tripId, isDeleted: false },
      select: { remainingSeats: true },
    });
    const min =
      rows.length === 0
        ? 0
        : rows.reduce((acc, row) => Math.min(acc, row.remainingSeats), Number.POSITIVE_INFINITY);
    await tx.trip.update({
      where: { id: tripId },
      data: { availableSeats: min, updatedAt: utcNow() },
    });
    return min;
  }
}
