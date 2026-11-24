import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newId, utcNow } from '../../common/utils/date.util';
import { money } from '../../common/utils/money';
import { RideRequestStatus } from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  DriverGateway,
  RideTrackingGateway,
  TripTrackingGateway,
} from './realtime.gateway';

export type RideOutboxEventType =
  | 'ride.accepted'
  | 'ride.started'
  | 'ride.completed'
  | 'ride.cancelled'
  | 'ride.driver_released'
  | 'ride.arrived'
  | 'ride.early_completed'
  | 'ride.cash_collected';

export type RideOutboxEvent = {
  eventType: RideOutboxEventType;
  aggregateId: string;
  payload: unknown;
};

type ClaimedEvent = {
  Id: string;
  EventType: RideOutboxEventType;
  AggregateId: string;
  Payload: Prisma.JsonValue;
  AttemptCount: number;
};

@Injectable()
export class RideOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RideOutboxService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly driverGateway: DriverGateway,
    private readonly rideTracking: RideTrackingGateway,
    private readonly tripTracking: TripTrackingGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.processPending(), 1000);
    this.timer.unref?.();
    void this.processPending();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(tx: Prisma.TransactionClient, event: RideOutboxEvent) {
    await tx.outboxEvent.create({
      data: {
        id: newId(),
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        payload: JSON.parse(JSON.stringify(event.payload)) as Prisma.InputJsonValue,
      },
    });
  }

  wake() {
    void this.processPending();
  }

  async processPending() {
    if (this.processing) return;
    this.processing = true;
    try {
      const events = await this.prisma.$transaction(async (tx) =>
        tx.$queryRaw<ClaimedEvent[]>`
          WITH candidates AS (
            SELECT "Id"
            FROM "OutboxEventsSet"
            WHERE ("Status" = 'pending' AND "NextAttemptAt" <= NOW())
               OR ("Status" = 'processing' AND "ProcessingStartedAt" < NOW() - INTERVAL '2 minutes')
            ORDER BY "CreatedAt", "Id"
            FOR UPDATE SKIP LOCKED
            LIMIT 50
          )
          UPDATE "OutboxEventsSet" AS events
          SET "Status" = 'processing',
              "AttemptCount" = events."AttemptCount" + 1,
              "ProcessingStartedAt" = NOW()
          FROM candidates
          WHERE events."Id" = candidates."Id"
          RETURNING events."Id", events."EventType", events."AggregateId",
                    events."Payload", events."AttemptCount"
        `,
      );

      for (const event of events) await this.deliver(event);
    } catch (error) {
      this.logger.error('Ride outbox batch failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.processing = false;
    }
  }

  private async deliver(event: ClaimedEvent) {
    try {
      const payload = this.asObject(event.Payload);
      switch (event.EventType) {
        case 'ride.accepted':
          if (!this.driverGateway.server || !this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.driverGateway.notifyClaimed(event.AggregateId, this.string(payload.acceptedByUserId), event.Id);
          this.rideTracking.publishRideAccepted(payload.mappedRide as never, event.Id);
          break;
        case 'ride.started':
          if (!this.rideTracking.server || !this.tripTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishRideStarted(
            event.AggregateId,
            this.date(payload.startedAt),
            this.string(payload.riderUserId),
            event.Id,
          );
          this.tripTracking.publishTripStarted(
            event.AggregateId,
            this.string(payload.riderUserId) ? [this.string(payload.riderUserId)!] : [],
            event.Id,
          );
          break;
        case 'ride.completed':
          if (!this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishRideCompleted(
            event.AggregateId,
            this.date(payload.completedAt),
            this.number(payload.fareAmount),
            this.number(payload.distanceKm),
            this.string(payload.riderUserId),
            event.Id,
          );
          break;
        case 'ride.early_completed':
          if (!this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishTerminationResolved(event.AggregateId, true, event.Id);
          this.rideTracking.publishRideCompleted(
            event.AggregateId,
            this.date(payload.completedAt),
            this.number(payload.fareAmount),
            this.number(payload.distanceKm),
            this.string(payload.riderUserId),
            event.Id,
          );
          break;
        case 'ride.cancelled':
          if (!this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishRideCancelled(
            event.AggregateId,
            payload.cancelledBy === 'driver' ? 'driver' : 'rider',
            this.string(payload.reason),
            event.Id,
          );
          if (payload.cancelledBy === 'rider' && this.string(payload.assignedDriverUserId)) {
            if (!this.driverGateway.server) throw new Error('Driver socket gateway is not ready');
            this.driverGateway.broadcastRideWithdrawn(
              event.AggregateId,
              [this.string(payload.assignedDriverUserId)!],
              event.Id,
            );
          }
          break;
        case 'ride.driver_released': {
          if (!this.rideTracking.server || !this.driverGateway.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishRideCancelled(
            event.AggregateId,
            'driver',
            this.string(payload.reason),
            event.Id,
          );
          const offer = await this.buildRedispatchedOffer(event.AggregateId, event.Id);
          if (offer) this.driverGateway.broadcastNewRide(offer as never);
          break;
        }
        case 'ride.arrived':
          if (!this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishArrivalConfirmed(event.AggregateId, this.string(payload.riderUserId), event.Id);
          break;
        case 'ride.cash_collected':
          if (!this.rideTracking.server) throw new Error('Ride socket gateway is not ready');
          this.rideTracking.publishFareCollected(
            event.AggregateId,
            this.number(payload.amount) ?? 0,
            this.string(payload.riderUserId),
            event.Id,
          );
          break;
      }
      await this.prisma.outboxEvent.update({
        where: { id: event.Id },
        data: { status: 'delivered', deliveredAt: utcNow(), processingStartedAt: null, lastError: null },
      });
    } catch (error) {
      const retrySeconds = Math.min(300, 2 ** Math.min(event.AttemptCount, 8));
      await this.prisma.outboxEvent.update({
        where: { id: event.Id },
        data: {
          status: 'pending',
          nextAttemptAt: new Date(Date.now() + retrySeconds * 1000),
          processingStartedAt: null,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        },
      });
      this.logger.warn(`Ride outbox event ${event.Id} failed; retry in ${retrySeconds}s`);
    }
  }

  private asObject(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private date(value: unknown): Date | undefined {
    if (typeof value !== 'string') return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private async buildRedispatchedOffer(rideId: string, eventId: string) {
    const ride = await this.prisma.rideRequest.findFirst({
      where: {
        id: rideId,
        isDeleted: false,
        status: RideRequestStatus.Requested,
        driverId: null,
      },
      include: { rider: true },
    });
    if (!ride || ride.pickupLatitude == null || ride.pickupLongitude == null) return null;
    const releasedDistance = ride.distanceKm ? Number(ride.distanceKm) : 2.5;
    const rider = ride.rider;
    return {
      id: ride.id,
      eventId,
      vehicleKind: ride.requestedVehicleKind || 'car',
      passengerName: rider?.fullName || 'Rider',
      passengerPhone: rider?.phone ?? null,
      passengerRating: rider ? Number(rider.ratingAverage) : 4.9,
      passengerRatingCount: rider?.ratingCount ?? 0,
      passengerAvatarUrl: rider?.avatarUrl ?? null,
      referenceCode: ride.referenceCode,
      pickupAddress: ride.pickupAddress || 'Pickup location',
      dropoffAddress: ride.destinationAddress || 'Destination',
      pickupLatitude: ride.pickupLatitude,
      pickupLongitude: ride.pickupLongitude,
      destinationLatitude: ride.destinationLatitude,
      destinationLongitude: ride.destinationLongitude,
      fare: money(ride.fareAmount),
      earnings: money(ride.captainEarnings),
      distanceKm: ride.distanceKm ? money(ride.distanceKm) : 2.5,
      tripDistanceKm: money(releasedDistance),
      durationMinutes: Math.max(1, Math.round((releasedDistance / 30) * 60)),
      etaMinutes: Math.max(3, Math.round(releasedDistance * 2.5)),
      paymentMethod: ride.paymentMethod || 'cash',
      timeoutSeconds: 30,
      createdAt: ride.createdAt,
    };
  }
}
