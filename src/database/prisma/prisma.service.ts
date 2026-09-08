import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async tryDecrementTripSeats(
    tripId: string,
    seatCount: number,
  ): Promise<number> {
    if (seatCount <= 0) {
      return 0;
    }
    const result = await this.$executeRaw`
      UPDATE "TripsSet"
      SET "AvailableSeats" = "AvailableSeats" - ${seatCount},
          "UpdatedAt" = NOW()
      WHERE "Id" = ${tripId}::uuid
        AND "IsDeleted" = false
        AND "AvailableSeats" >= ${seatCount}
        AND "Status" IN (1, 2)`;
    return Number(result);
  }

  async tryIncrementTripSeats(
    tripId: string,
    seatCount: number,
  ): Promise<number> {
    if (seatCount <= 0) {
      return 0;
    }
    const result = await this.$executeRaw`
      UPDATE "TripsSet"
      SET "AvailableSeats" = "AvailableSeats" + ${seatCount},
          "UpdatedAt" = NOW()
      WHERE "Id" = ${tripId}::uuid
        AND "IsDeleted" = false`;
    return Number(result);
  }

  async markTripFullIfNeeded(tripId: string): Promise<void> {
    await this.$executeRaw`
      UPDATE "TripsSet"
      SET "Status" = 2,
          "UpdatedAt" = NOW()
      WHERE "Id" = ${tripId}::uuid
        AND "IsDeleted" = false
        AND "AvailableSeats" <= 0
        AND "Status" = 1`;
  }

  async acquireTransactionAdvisoryLock(lockKey: bigint | number): Promise<void> {
    await this.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
  }
}
