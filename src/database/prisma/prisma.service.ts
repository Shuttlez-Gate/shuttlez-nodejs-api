import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { recordPerformanceDiagnostic } from '../../common/performance-diagnostics';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    // The bundled Prisma engine cannot open this Neon endpoint from this
    // machine. node-pg can, so queries go through that driver.
    super(
      connectionString
        ? {
            adapter: new PrismaPg({ connectionString }),
            ...(process.env.SHUTTLEZ_PERF_DIAGNOSTICS === '1'
              ? { log: [{ emit: 'event' as const, level: 'query' as const }] }
              : {}),
          }
        : undefined,
    );
    if (process.env.SHUTTLEZ_PERF_DIAGNOSTICS === '1') {
      const subscribeToQuery = this.$on as unknown as (
        event: 'query',
        callback: (event: { query: string; duration: number }) => void,
      ) => void;
      subscribeToQuery.call(this, 'query', (event) => {
        const operation = /^\s*(SELECT|INSERT|UPDATE|DELETE)/i.exec(event.query)?.[1]
          ?.toUpperCase() ?? 'QUERY';
        const relation = /"(?:public\.)?([^"]+Set)"/.exec(event.query)?.[1] ?? 'raw';
        recordPerformanceDiagnostic('database.prisma_query', {
          operation,
          relation,
          durationMs: event.duration,
        });
      });
    }
  }

  async onModuleInit(): Promise<void> {
    const maxRetries = 5;
    const retryDelay = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Successfully connected to database.');
        return;
       } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        if (attempt === maxRetries) {
          this.logger.error(
            `Failed to connect to database after ${maxRetries} attempts: ${errorMessage}`,
          );
          throw err;
        }

        this.logger.warn(
          `Database connection attempt ${attempt}/${maxRetries} failed (${errorMessage}). Retrying in ${retryDelay / 1000}s (database might be waking up)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
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

  async lockTrip(tripId: string): Promise<void> {
    await this.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tripId}))`;
  }
}
