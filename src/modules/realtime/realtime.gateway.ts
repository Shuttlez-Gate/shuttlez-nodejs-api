import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../database/prisma/prisma.service';
import { newId } from '../../common/utils/date.util';
import {
  BookingStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
} from '../../common/enums';
import { rideStatusLabel, captainVehicleKind } from '../../common/utils/enums-map';
import { OfferAudience, selectBroadcastRecipients } from '../drivers/ride-offer-policy';
import { SocketIdentity } from './socket-identity';
import {
  onRiderHistoryChange,
  RiderHistoryChange,
} from './rider-history-signal';
import {
  parseBroadcastCaptainLocation,
  parseConfirmArrival,
  parseJoinRide,
  parseLeaveRide,
  parseRequestTermination,
  parseResolveTermination,
} from './socket-payload';
import type { BroadcastCaptainLocationMessage } from './socket-payload';
import {
  RideTrackingAuthorizationService,
  RIDE_ID_PATTERN,
  type RideParticipantRole,
} from './ride-tracking.authorization';
import type { RidesService } from '../rides/rides.service';

type TripLiveProgress = {
  stopOrder: number;
  boardedUserIds: string[];
  boardedBookingIds: string[];
  notifyUserIds: string[];
  latitude?: number;
  longitude?: number;
  heading?: number;
};
type MappedRide = ReturnType<RidesService['mapRide']>;
type AcceptedRidePayload = Omit<
  MappedRide,
  'captainLatitude' | 'captainLongitude' | 'captainLocationUpdatedAt'
> & {
  captainLatitude: number | null;
  captainLongitude: number | null;
  captainLocationUpdatedAt: string | null;
};
function hubText(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (Array.isArray(body)) return hubText(body[0]);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    return String(record.tripId ?? record.id ?? '').trim();
  }
  return '';
}

function hubRecord(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) return hubRecord(body[0]);
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

function claimedSocketUserId(payload: Record<string, unknown>): string | null {
  const value = payload.userId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function hubIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

@WebSocketGateway({
  path: '/hubs/trip-tracking',
  cors: { origin: true, credentials: true },
})
export class TripTrackingGateway {
  @WebSocketServer()
  server!: Server;

  private readonly progressByTrip = new Map<string, TripLiveProgress>();

  constructor(
    private readonly identity: SocketIdentity,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('JoinTrip')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const id = hubText(body).toLowerCase();
    if (!id) return;
    const userId = await this.identity.userId(client);
    if (!userId || !(await this.canReadTrip(id, userId))) return;
    await client.join(`trip-${id}`);
    await client.join(`user-${userId.toLowerCase()}`);
    const startedAt = await this.startedAt(id);
    if (startedAt) {
      client.emit('TripStarted', {
        tripId: id,
        status: 'InProgress',
        startedAt,
      });
    }
    const progress = this.progressByTrip.get(id);
    if (!progress) return;
    client.emit('TripProgressUpdated', {
      tripId: id,
      stopOrder: progress.stopOrder,
      boardedUserIds: progress.boardedUserIds,
      boardedBookingIds: progress.boardedBookingIds,
      notifyUserIds: progress.notifyUserIds,
    });
    if (progress.latitude == null || progress.longitude == null) return;
    client.emit('DriverLocationUpdated', {
      tripId: id,
      latitude: progress.latitude,
      longitude: progress.longitude,
      heading: progress.heading ?? 0,
      stopOrder: progress.stopOrder,
      boardedUserIds: progress.boardedUserIds,
      boardedBookingIds: progress.boardedBookingIds,
    });
  }

  @SubscribeMessage('LeaveTrip')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() tripId: string) {
    await client.leave(`trip-${tripId}`);
  }

  @SubscribeMessage('BroadcastDriverLocation')
  async location(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const payload = hubRecord(body);
    const tripId = String(payload.tripId ?? '').trim().toLowerCase();
    if (!tripId || !(await this.canWriteTrip(client, tripId))) return;
    const progress = this.remember(tripId, payload);
    const event = {
      tripId,
      latitude: Number(payload.latitude),
      longitude: Number(payload.longitude),
      heading: Number(payload.heading ?? 0),
      stopOrder: progress.stopOrder,
      boardedUserIds: progress.boardedUserIds,
      boardedBookingIds: progress.boardedBookingIds,
      timestamp: new Date().toISOString(),
    };
    this.emitLive(tripId, 'DriverLocationUpdated', event, progress);
  }

  @SubscribeMessage('BroadcastTripProgress')
  async progress(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const payload = hubRecord(body);
    const tripId = String(payload.tripId ?? '').trim().toLowerCase();
    if (!tripId || !(await this.canWriteTrip(client, tripId))) return;
    const progress = this.remember(tripId, payload);
    this.emitLive(tripId, 'TripProgressUpdated', {
      tripId,
      stopOrder: progress.stopOrder,
      boardedUserIds: progress.boardedUserIds,
      boardedBookingIds: progress.boardedBookingIds,
    }, progress);
  }

  applyLive(body: Record<string, unknown>): TripLiveProgress {
    const tripId = String(body.tripId ?? '').trim().toLowerCase();
    if (!tripId) {
      return {
        stopOrder: 0,
        boardedUserIds: [],
        boardedBookingIds: [],
        notifyUserIds: [],
      };
    }
    const progress = this.remember(tripId, body);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && body.latitude != null) {
      this.emitLive(tripId, 'DriverLocationUpdated', {
        tripId,
        latitude,
        longitude,
        heading: Number(body.heading ?? 0),
        stopOrder: progress.stopOrder,
        boardedUserIds: progress.boardedUserIds,
        boardedBookingIds: progress.boardedBookingIds,
        timestamp: new Date().toISOString(),
      }, progress);
    }
    this.emitLive(tripId, 'TripProgressUpdated', {
      tripId,
      stopOrder: progress.stopOrder,
      boardedUserIds: progress.boardedUserIds,
      boardedBookingIds: progress.boardedBookingIds,
    }, progress);
    return progress;
  }

  publishTripStarted(tripId: string, riderUserIds: string[], eventId?: string): void {
    const id = tripId.trim().toLowerCase();
    if (!this.server || !id) return;
    const payload = {
      tripId: id,
      status: 'InProgress',
      startedAt: new Date().toISOString(),
      ...(eventId ? { eventId } : {}),
    };
    let room = this.server.to(`trip-${id}`);
    for (const riderUserId of riderUserIds) {
      const userId = riderUserId.trim().toLowerCase();
      if (userId) room = room.to(`user-${userId}`);
    }
    room.emit('TripStarted', payload);
  }

  snapshot(tripId: string): TripLiveProgress {
    return (
      this.progressByTrip.get(tripId.trim().toLowerCase()) ?? {
        stopOrder: 0,
        boardedUserIds: [],
        boardedBookingIds: [],
        notifyUserIds: [],
      }
    );
  }

  publishChat(message: {
    id: string;
    tripId: string;
    bookingId: string | null;
    senderUserId: string;
    fromDriver?: boolean;
    body: string;
    createdAt: string;
    riderUserId?: string | null;
    driverUserId?: string | null;
  }) {
    if (!this.server || !message.tripId) return;
    const tripId = message.tripId.toLowerCase();
    const event = { ...message, tripId };
    let room = this.server.to(`trip-${tripId}`);
    for (const userId of [message.senderUserId, message.riderUserId, message.driverUserId]) {
      const id = userId?.trim().toLowerCase();
      if (id) room = room.to(`user-${id}`);
    }
    room.emit('TripChatMessage', event);
  }

  private emitLive(
    tripId: string,
    event: string,
    payload: unknown,
    progress: TripLiveProgress,
  ) {
    if (!this.server) return;
    let room = this.server.to(`trip-${tripId}`);
    const users = new Set<string>([
      ...progress.boardedUserIds,
      ...progress.notifyUserIds,
    ]);
    for (const userId of users) {
      const id = userId.trim().toLowerCase();
      if (id) room = room.to(`user-${id}`);
    }
    room.emit(event, payload);
  }

  private remember(tripId: string, payload: Record<string, unknown>): TripLiveProgress {
    const previous = this.progressByTrip.get(tripId);
    const boardedUserIds = payload.boardedUserIds == null
      ? previous?.boardedUserIds ?? []
      : hubIds(payload.boardedUserIds);
    const boardedBookingIds = payload.boardedBookingIds == null
      ? previous?.boardedBookingIds ?? []
      : hubIds(payload.boardedBookingIds);
    const notifyUserIds = payload.notifyUserIds == null
      ? previous?.notifyUserIds ?? []
      : hubIds(payload.notifyUserIds);
    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    const hasPoint =
      payload.latitude != null &&
      payload.longitude != null &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude);
    const next: TripLiveProgress = {
      stopOrder: payload.stopOrder == null
        ? previous?.stopOrder ?? 0
        : Number(payload.stopOrder) || 0,
      boardedUserIds,
      boardedBookingIds,
      notifyUserIds,
      latitude: hasPoint ? latitude : previous?.latitude,
      longitude: hasPoint ? longitude : previous?.longitude,
      heading: payload.heading == null
        ? previous?.heading
        : Number(payload.heading) || 0,
    };
    this.progressByTrip.set(tripId, next);
    return next;
  }

  private async startedAt(id: string): Promise<string | null> {
    try {
      return await this.lookupStartedAt(id);
    } catch {
      return null;
    }
  }

  private async lookupStartedAt(id: string): Promise<string | null> {
    const trip = await this.prisma.trip.findFirst({
      where: { id, isDeleted: false },
      select: { status: true, startedAt: true },
    });
    if (trip) {
      return trip.status === TripStatus.InProgress
        ? trip.startedAt?.toISOString() ?? new Date().toISOString()
        : null;
    }
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id, isDeleted: false },
      select: { status: true, startedAt: true },
    });
    if (ride) {
      return ride.status === RideRequestStatus.InProgress
        ? ride.startedAt?.toISOString() ?? new Date().toISOString()
        : null;
    }
    const group = await this.prisma.groupRequest.findFirst({
      where: { id, isDeleted: false },
      select: { status: true, startedAt: true },
    });
    if (group?.status !== GroupRequestStatus.InProgress) return null;
    return group.startedAt?.toISOString() ?? new Date().toISOString();
  }

  private async canReadTrip(tripId: string, userId: string): Promise<boolean> {
    try {
      const trip = await this.prisma.trip.findFirst({
        where: { id: tripId, isDeleted: false },
        select: {
          driver: { select: { userId: true } },
          bookings: {
            where: { isDeleted: false, status: { not: BookingStatus.Cancelled } },
            select: { userId: true },
          },
        },
      });
      const actor = userId.toLowerCase();
      if (trip) {
        if (trip.driver?.userId?.toLowerCase() === actor) return true;
        return trip.bookings.some((booking) => booking.userId.toLowerCase() === actor);
      }
      const ride = await this.prisma.rideRequest.findFirst({
        where: { id: tripId, isDeleted: false },
        select: {
          riderUserId: true,
          driver: { select: { userId: true } },
        },
      });
      if (ride) {
        if (ride.riderUserId.toLowerCase() === actor) return true;
        return ride.driver?.userId?.toLowerCase() === actor;
      }
      const group = await this.prisma.groupRequest.findFirst({
        where: { id: tripId, isDeleted: false },
        select: {
          organizerUserId: true,
          driver: { select: { userId: true } },
          members: {
            where: { isDeleted: false },
            select: { userId: true },
          },
        },
      });
      if (!group) return false;
      if (group.organizerUserId.toLowerCase() === actor) return true;
      if (group.driver?.userId?.toLowerCase() === actor) return true;
      return group.members.some((member) => member.userId.toLowerCase() === actor);
    } catch {
      return false;
    }
  }

  private async canWriteTrip(client: Socket, tripId: string): Promise<boolean> {
    const userId = await this.identity.userId(client);
    if (!userId) return false;
    const actor = userId.toLowerCase();
    try {
      const trip = await this.prisma.trip.findFirst({
        where: { id: tripId, isDeleted: false },
        select: { driver: { select: { userId: true } } },
      });
      if (trip) return trip.driver?.userId?.toLowerCase() === actor;
      const ride = await this.prisma.rideRequest.findFirst({
        where: { id: tripId, isDeleted: false },
        select: { driver: { select: { userId: true } } },
      });
      if (ride) return ride.driver?.userId?.toLowerCase() === actor;
      const group = await this.prisma.groupRequest.findFirst({
        where: { id: tripId, isDeleted: false },
        select: { driver: { select: { userId: true } } },
      });
      return group?.driver?.userId?.toLowerCase() === actor;
    } catch {
      return false;
    }
  }
}

function supportTicketId(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (Array.isArray(body)) return supportTicketId(body[0]);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    return String(record.ticketId ?? record.id ?? '').trim();
  }
  return '';
}

export type SupportChatPayload = {
  id: string;
  ticketId: string;
  isFromSupport: boolean;
  content: string;
  createdAt: string;
};

@WebSocketGateway({
  path: '/hubs/support-chat',
  cors: { origin: true, credentials: true },
})
export class SupportChatGateway {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly identity: SocketIdentity,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('JoinTicket')
  async join(@ConnectedSocket() client: Socket, @MessageBody() ticketId: unknown) {
    const id = supportTicketId(ticketId);
    const userId = await this.identity.userId(client);
    if (!id || !userId) return;
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, userId, isDeleted: false },
      select: { id: true },
    });
    if (!ticket) return;
    await client.join(`ticket-${ticket.id}`);
  }

  @SubscribeMessage('LeaveTicket')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() ticketId: unknown) {
    const id = supportTicketId(ticketId);
    const userId = await this.identity.userId(client);
    if (!id || !userId) return;
    await client.leave(`ticket-${id}`);
  }

  publish(message: SupportChatPayload) {
    this.server?.to(`ticket-${message.ticketId}`).emit('SupportMessageCreated', message);
  }
}

function typingRecord(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) return typingRecord(body[0]);
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

function isHubUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export type GroupUpdatedPayload = {
  id: string;
  organizerUserId: string;
};

export type GroupChatPayload = {
  id: string;
  groupId: string;
  senderUserId: string;
  recipientUserId: string;
  body: string;
  createdAt: Date;
};

@WebSocketGateway({
  path: '/hubs/group',
  cors: { origin: true, credentials: true },
})
export class GroupGateway {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('JoinUser')
  async joinUser(@ConnectedSocket() client: Socket) {
    const userId = await this.userId(client);
    if (!userId) return;
    await client.join(`user-${userId}`);
  }

  @SubscribeMessage('JoinGroup')
  async joinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() groupId: string,
  ) {
    const userId = await this.userId(client);
    const id = groupId?.trim();
    if (!userId || !id) return;
    const group = await this.prisma.groupRequest.findFirst({
      where: {
        isDeleted: false,
        ...(isHubUuid(id) ? { id } : { referenceCode: id }),
      },
      select: { id: true, organizerUserId: true },
    });
    if (!group) return;
    const member = await this.prisma.groupMember.findFirst({
      where: { groupRequestId: group.id, userId, isDeleted: false },
      select: { id: true },
    });
    if (group.organizerUserId !== userId && !member) return;
    await client.join(`user-${userId}`);
    await client.join(`group-${group.id}`);
  }

  @SubscribeMessage('LeaveGroup')
  async leaveGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() groupId: string,
  ) {
    const id = groupId?.trim();
    if (!id) return;
    await client.leave(`group-${id}`);
  }

  publish(group: GroupUpdatedPayload) {
    if (!group.id || !this.server) return;
    this.server
      .to(`group-${group.id}`)
      .to(`user-${group.organizerUserId}`)
      .emit('GroupUpdated', group);
  }

  publishChat(message: GroupChatPayload) {
    if (!message.groupId || !this.server) return;
    this.server
      .to(`user-${message.senderUserId}`)
      .to(`user-${message.recipientUserId}`)
      .emit('GroupChatMessage', message);
  }

  publishChatRead(payload: { groupId: string; readerUserId: string; peerUserId: string }) {
    if (!payload.groupId || !this.server) return;
    this.server.to(`user-${payload.readerUserId}`).emit('GroupChatRead', payload);
  }

  publishTyping(payload: {
    groupId: string;
    senderUserId: string;
    peerUserId: string;
    typing: boolean;
  }) {
    if (!payload.groupId || !this.server) return;
    this.server
      .to(`user-${payload.peerUserId}`)
      .to(`group-${payload.groupId}`)
      .emit('GroupChatTyping', {
        groupId: payload.groupId,
        senderUserId: payload.senderUserId,
        typing: payload.typing,
      });
  }

  @SubscribeMessage('GroupChatTyping')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: unknown,
  ) {
    const userId = await this.userId(client);
    const record = typingRecord(body);
    const groupId = String(record.groupId ?? '').trim();
    const peerUserId = String(record.peerUserId ?? '').trim();
    const typing = record.typing === true || record.typing === 'true';
    if (!userId || !isHubUuid(groupId) || !isHubUuid(peerUserId) || peerUserId === userId) {
      return;
    }
    const [member, peer] = await Promise.all([
      this.prisma.groupMember.findFirst({
        where: { groupRequestId: groupId, userId, isDeleted: false },
        select: { id: true },
      }),
      this.prisma.groupMember.findFirst({
        where: { groupRequestId: groupId, userId: peerUserId, isDeleted: false },
        select: { id: true },
      }),
    ]);
    if (!member || !peer) return;
    this.publishTyping({
      groupId,
      senderUserId: userId,
      peerUserId,
      typing,
    });
  }

  private async userId(client: Socket): Promise<string> {
    const token = String(client.handshake.auth?.token ?? '').trim();
    if (!token) return '';
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      return payload.sub ?? '';
    } catch {
      return '';
    }
  }
}

@WebSocketGateway({
  path: '/hubs/rider',
  cors: { origin: true, credentials: true },
})
export class RiderHistoryGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private stopListen: (() => void) | null = null;

  constructor(private readonly jwt: JwtService) {}

  onModuleInit(): void {
    this.stopListen = onRiderHistoryChange((change) => this.publish(change));
  }

  onModuleDestroy(): void {
    this.stopListen?.();
    this.stopListen = null;
  }

  @SubscribeMessage('JoinUser')
  async joinUser(@ConnectedSocket() client: Socket) {
    const userId = await this.userId(client);
    if (!userId) return;
    await client.join(`user-${userId}`);
  }

  publish(change: RiderHistoryChange): void {
    if (!change.userId || !this.server) return;
    this.server.to(`user-${change.userId}`).emit('RiderHistoryChanged', change);
  }

  private async userId(client: Socket): Promise<string> {
    const token = String(client.handshake.auth?.token ?? '').trim();
    if (!token) return '';
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      return payload.sub ?? '';
    } catch {
      return '';
    }
  }
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface DriverLivePresence {
  userId: string;
  socketId?: string;
  latitude: number;
  longitude: number;
  hasActiveRide?: boolean;
  remainingMinutes?: number;
  vehicleKind?: string | null;
  updatedAt: number;
}

@WebSocketGateway({
  path: '/hubs/driver',
  cors: { origin: true, credentials: true },
})
export class DriverGateway {
  @WebSocketServer()
  server!: Server;

  private driverPresences = new Map<string, DriverLivePresence>();
  private readonly offerAudience = new OfferAudience();

  constructor(
    private readonly identity: SocketIdentity,
    private readonly prisma: PrismaService,
  ) {}

  getDriverPresence(userId: string): DriverLivePresence | undefined {
    return this.driverPresences.get(userId);
  }

  releaseActiveRide(userId: string) {
    const presence = this.driverPresences.get(userId);
    if (!presence) return;
    this.driverPresences.set(userId, {
      ...presence,
      hasActiveRide: false,
      remainingMinutes: undefined,
    });
  }

  handleDisconnect(client: Socket) {
    for (const [key, presence] of this.driverPresences.entries()) {
      if (presence.socketId === client.id) {
        this.driverPresences.delete(key);
      }
    }
  }

  @SubscribeMessage('JoinDriverRoom')
  async join(@ConnectedSocket() client: Socket, @MessageBody() data?: unknown) {
    const payload = hubRecord(data);
    const userId = await this.identity.userId(client, claimedSocketUserId(payload));
    if (!userId) return;
    await client.join(`driver-${userId}`);
    await client.join('drivers-online');
    await this.rememberPresence(client, userId, payload);
  }

  @SubscribeMessage('UpdateDriverLocation')
  async updateLocation(@ConnectedSocket() client: Socket, @MessageBody() data?: unknown) {
    const payload = hubRecord(data);
    const userId = await this.identity.userId(client, claimedSocketUserId(payload));
    if (!userId || payload.latitude == null || payload.longitude == null) return;
    await client.join(`driver-${userId}`);
    await this.rememberPresence(client, userId, payload);
  }

  broadcastNewRide(ride: {
    pickupLatitude?: number;
    pickupLongitude?: number;
    vehicleKind?: unknown;
    [key: string]: unknown;
  }) {
    if (!this.server) return;
    const recipients = selectBroadcastRecipients({
      pickupLatitude: typeof ride.pickupLatitude === 'number' ? ride.pickupLatitude : null,
      pickupLongitude: typeof ride.pickupLongitude === 'number' ? ride.pickupLongitude : null,
      requestedVehicleKind: typeof ride.vehicleKind === 'string' ? ride.vehicleKind : null,
      nowMs: Date.now(),
      presences: [...this.driverPresences.values()].map((presence) => ({
        userId: presence.userId,
        latitude: presence.latitude,
        longitude: presence.longitude,
        hasActiveRide: presence.hasActiveRide,
        remainingMinutes: presence.remainingMinutes,
        vehicleKind: presence.vehicleKind,
        updatedAtMs: presence.updatedAt,
      })),
    });
    this.offerAudience.remember(
      String(ride.id ?? ''),
      recipients.map((recipient) => recipient.userId),
    );
    for (const recipient of recipients) {
      const targetedPayload = {
        ...ride,
        distanceKm: Number(recipient.distanceKm.toFixed(1)),
      };
      this.server.to(`driver-${recipient.userId}`).emit('NewRideRequest', targetedPayload);
      const presence = this.driverPresences.get(recipient.userId);
      if (presence?.socketId) {
        this.server.to(presence.socketId).emit('NewRideRequest', targetedPayload);
      }
    }
    console.log(
      `[DriverGateway] broadcastNewRide ${String(ride.id)}: targeted ${recipients.length} of ${this.driverPresences.size} drivers`,
    );
  }

  private async rememberPresence(
    client: Socket,
    userId: string,
    payload: Record<string, unknown>,
  ) {
    if (payload.latitude == null || payload.longitude == null) return;
    const previous = this.driverPresences.get(userId);
    let vehicleKind = previous?.vehicleKind;
    if (vehicleKind == null) {
      try {
        const driver = await this.prisma.driver.findFirst({
          where: { userId, isDeleted: false },
          select: { vehicleKind: true, vehicle: { select: { type: true } } },
        });
        vehicleKind = captainVehicleKind(driver);
      } catch {
        vehicleKind = previous?.vehicleKind ?? null;
      }
    }
    this.driverPresences.set(userId, {
      userId,
      socketId: client.id,
      latitude: Number(payload.latitude),
      longitude: Number(payload.longitude),
      hasActiveRide:
        payload.hasActiveRide == null ? previous?.hasActiveRide : Boolean(payload.hasActiveRide),
      remainingMinutes:
        payload.remainingMinutes == null
          ? previous?.remainingMinutes
          : Number(payload.remainingMinutes),
      vehicleKind,
      updatedAt: Date.now(),
    });
  }

  rememberOffer(rideId: string, userId: string) {
    this.offerAudience.remember(rideId, [userId]);
  }

  broadcastRideWithdrawn(rideId: string, extraUserIds: string[] = [], eventId?: string) {
    if (!this.server || !rideId) return;
    const targets = this.offerAudience.targets(rideId, extraUserIds);
    this.offerAudience.forget(rideId);
    const payload = {
      rideId,
      status: 'Cancelled',
      cancelledBy: 'rider',
      ...(eventId ? { eventId } : {}),
    };
    for (const userId of targets) {
      this.server.to(`driver-${userId}`).emit('RideRequestCancelled', payload);
      const presence = this.driverPresences.get(userId);
      if (presence?.socketId) {
        this.server.to(presence.socketId).emit('RideRequestCancelled', payload);
      }
    }
    console.log(
      `[DriverGateway] RideRequestCancelled ${rideId}: notified ${targets.length}`,
    );
  }

  notifyClaimed(rideId: string, acceptedByUserId?: string, eventId?: string) {
    this.offerAudience.forget(rideId);
    if (!this.server) return;
    if (acceptedByUserId) {
      this.server
        .to('drivers-online')
        .except(`driver-${acceptedByUserId}`)
        .emit('RideRequestClaimed', { rideId, acceptedByUserId, ...(eventId ? { eventId } : {}) });
    } else {
      this.server.to('drivers-online').emit('RideRequestClaimed', { rideId, ...(eventId ? { eventId } : {}) });
    }
  }
}


export interface CaptainLocationPayload {
  rideId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: string;
}

export interface EarlyTerminationPayload {
  rideId: string;
  initiator: 'rider' | 'driver';
  reason: string;
  requestedAt: string;
  latitude?: number;
  longitude?: number;
}

interface RideStateSnapshot {
  id: string;
  rideId: string;
  riderUserId: string;
  status: string;
  arrivedAtPickup: boolean;
  driverId: string | null;
  driverName: string | null;
  driverPhone: string | null;
  driverPhotoUrl: string | null;
  driverRatingAverage: number | null;
  driverRatingCount: number | null;
  vehicleKind: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  plateNumber: string | null;
  pickupLatitude: number;
  pickupLongitude: number;
  pickupAddress: string | null;
  destinationLatitude: number;
  destinationLongitude: number;
  destinationAddress: string | null;
  fareAmount: number;
  distanceKm: number | null;
  captainLatitude: number | null;
  captainLongitude: number | null;
  captainLocationUpdatedAt: string | null;
  fareCollected: boolean;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  pendingTermination: EarlyTerminationPayload | null;
}

@WebSocketGateway({
  path: '/hubs/ride-tracking',
  cors: { origin: true, credentials: true },
})
export class RideTrackingGateway {
  @WebSocketServer()
  server!: Server;

  private arrivedRides = new Set<string>();
  private collectedRides = new Set<string>();
  private lastLocations = new Map<string, CaptainLocationPayload>();
  private pendingTerminations = new Map<string, EarlyTerminationPayload>();
  private riderByRide = new Map<string, string>();
  private terminationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly identity: SocketIdentity,
    private readonly prisma: PrismaService,
    private readonly authorization: RideTrackingAuthorizationService,
  ) {}

  getLastLocation(rideId: string): CaptainLocationPayload | undefined {
    return this.lastLocations.get(rideId);
  }

  isArrived(rideId: string): boolean {
    return this.arrivedRides.has(rideId);
  }

  getPendingTermination(rideId: string): EarlyTerminationPayload | undefined {
    return this.pendingTerminations.get(rideId);
  }

  private rememberRider(rideId: string, riderUserId?: string | null) {
    if (rideId && riderUserId) this.riderByRide.set(rideId, riderUserId);
  }

  private emitRide(
    rideId: string,
    event: string,
    payload: unknown,
    riderUserId?: string | null,
  ) {
    this.rememberRider(rideId, riderUserId);
    if (!this.server || !rideId) return;
    const userId = riderUserId || this.riderByRide.get(rideId);
    let room = this.server.to(`ride-${rideId}`);
    const lowerRide = rideId.toLowerCase();
    if (lowerRide !== rideId) room = room.to(`ride-${lowerRide}`);
    if (userId) {
      room = room.to(`user-${userId}`);
      const lowerUser = userId.toLowerCase();
      if (lowerUser !== userId) room = room.to(`user-${lowerUser}`);
    }
    room.emit(event, payload);
  }

  private async userId(client: Socket, claimedUserId?: string | null): Promise<string> {
    return (await this.identity.userId(client, claimedUserId)) ?? '';
  }

  /** Resolve the caller's role from the signed-in identity and current DB ownership. */
  private async authorizeRide(
    client: Socket,
    rideId: string,
    roles: RideParticipantRole[],
    statuses?: number[],
  ): Promise<{ ride: import('./ride-tracking.authorization').AuthorizedRide; userId: string; role: RideParticipantRole } | null> {
    const userId = await this.userId(client);
    if (!userId) return null;
    const authorized = await this.authorization.authorize(rideId, userId, roles, statuses);
    return authorized ? { ...authorized, userId } : null;
  }

  private async withTerminationLock<T>(rideId: string, action: () => Promise<T>): Promise<T> {
    const key = rideId.toLowerCase();
    const previous = this.terminationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => tail);
    this.terminationLocks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.terminationLocks.get(key) === queued) this.terminationLocks.delete(key);
    }
  }

  private validLocation(loc: BroadcastCaptainLocationMessage): boolean {
    return loc.latitude >= -90 && loc.latitude <= 90 &&
      loc.longitude >= -180 && loc.longitude <= 180 &&
      (loc.heading === undefined || (loc.heading >= 0 && loc.heading <= 360)) &&
      (loc.speed === undefined || loc.speed >= 0);
  }

  @SubscribeMessage('JoinRide')
  async joinRide(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const message = parseJoinRide(data);
    const rideId = message.rideId;
    if (!rideId || !RIDE_ID_PATTERN.test(rideId)) return { success: false, reason: 'INVALID_REQUEST' };
    const authorized = await this.authorizeRide(client, rideId, ['rider', 'driver']);
    if (!authorized) return { success: false, reason: 'UNAUTHORIZED' };
    const { ride, userId: resolvedUserId } = authorized;
    // A client-supplied identity is only an assertion and must match the verified identity.
    if (message.userId && message.userId.toLowerCase() !== resolvedUserId.toLowerCase()) {
      return { success: false, reason: 'UNAUTHORIZED' };
    }

    const canonicalRideId = ride.id.toLowerCase();
    const state = await this.buildRideState(ride.id);
    const stillAuthorized = await this.authorizeRide(client, canonicalRideId, ['rider', 'driver']);
    if (!state || !stillAuthorized) return { success: false, reason: 'UNAUTHORIZED' };
    await client.join(`ride-${canonicalRideId}`);
    await client.join(`user-${resolvedUserId.toLowerCase()}`);

    client.emit('JoinRideAcknowledged', {
      rideId: canonicalRideId,
      userId: resolvedUserId,
      success: true,
      status: state?.status,
    });

    if (state) {
      this.rememberRider(canonicalRideId, state.riderUserId);
      client.emit('RideStateSync', state);
    }
    return { success: true, rideId: canonicalRideId, status: state?.status, state };
  }

  @SubscribeMessage('LeaveRide')
  async leaveRide(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
    const rideId = parseLeaveRide(data).rideId;
    if (!rideId) return;
    await client.leave(`ride-${rideId}`);
  }

  @SubscribeMessage('BroadcastCaptainLocation')
  async broadcastLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const loc = parseBroadcastCaptainLocation(data);
    if (!loc || !RIDE_ID_PATTERN.test(loc.rideId) || !this.validLocation(loc)) {
      return { success: false, reason: 'INVALID_REQUEST' };
    }
    const authorized = await this.authorizeRide(client, loc.rideId, ['driver'], [
      RideRequestStatus.Assigned,
      RideRequestStatus.InProgress,
    ]);
    if (!authorized) return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
    const { ride } = authorized;
    const rideId = ride.id.toLowerCase();
    const safeLocation = { ...loc, rideId, timestamp: new Date().toISOString() };
    this.lastLocations.set(rideId, safeLocation);
    this.emitRide(rideId, 'CaptainLocationUpdated', safeLocation, ride.riderUserId);

    // Proximity check for arrival prompt (< 100 meters)
    if (!this.arrivedRides.has(rideId)) {
      if (
        ride.status === RideRequestStatus.Assigned
      ) {
        const distKm = haversineDistanceKm(
          safeLocation.latitude,
          safeLocation.longitude,
          ride.pickupLatitude,
          ride.pickupLongitude,
        );
        if (distKm <= 0.10) {
          client.emit('CaptainArrivalDetected', {
            rideId,
            distanceMeters: Math.round(distKm * 1000),
            pickupLatitude: ride.pickupLatitude,
            pickupLongitude: ride.pickupLongitude,
          });
        }
      }
    }
    return { success: true };
  }

  @SubscribeMessage('ConfirmArrival')
  async confirmArrival(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const rideId = parseConfirmArrival(data).rideId;
    if (!rideId || !RIDE_ID_PATTERN.test(rideId)) return { success: false, reason: 'INVALID_REQUEST' };
    const authorized = await this.authorizeRide(client, rideId, ['driver'], [RideRequestStatus.Assigned]);
    if (!authorized) return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
    if (authorized.ride.driverArrivedAt) return { success: true, idempotent: true };
    const arrivedAt = new Date();
    const eventId = newId();
    const confirmed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.rideRequest.updateMany({
        where: {
          id: authorized.ride.id,
          driverId: authorized.ride.driverId,
          isDeleted: false,
          status: RideRequestStatus.Assigned,
          driverArrivedAt: null,
        },
        data: { driverArrivedAt: arrivedAt, updatedAt: arrivedAt },
      });
      if (result.count === 1) {
        await tx.outboxEvent.create({
          data: {
            id: eventId,
            eventType: 'ride.arrived',
            aggregateId: authorized.ride.id,
            payload: { riderUserId: authorized.ride.riderUserId, arrivedAt: arrivedAt.toISOString() },
          },
        });
      }
      return result;
    });
    if (confirmed.count !== 1) {
      const current = await this.prisma.rideRequest.findFirst({
        where: { id: authorized.ride.id, driverId: authorized.ride.driverId, isDeleted: false },
      });
      if (current?.status === RideRequestStatus.Assigned && current.driverArrivedAt) {
        return { success: true, idempotent: true };
      }
      return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
    }
    this.publishArrivalConfirmed(authorized.ride.id.toLowerCase(), authorized.ride.riderUserId, eventId);
    if (this.server) {
      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'delivered', deliveredAt: new Date(), processingStartedAt: null },
      });
    }
    return { success: true };
  }

  @SubscribeMessage('RequestTermination')
  async requestTermination(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const message = parseRequestTermination(data);
    if (!RIDE_ID_PATTERN.test(message.rideId) ||
      (message.latitude !== undefined && (message.latitude < -90 || message.latitude > 90)) ||
      (message.longitude !== undefined && (message.longitude < -180 || message.longitude > 180)) ||
      ((message.latitude === undefined) !== (message.longitude === undefined))) {
      return { success: false, reason: 'INVALID_REQUEST' };
    }
    return this.withTerminationLock(message.rideId, async () => {
      const authorized = await this.authorizeRide(client, message.rideId, ['rider', 'driver'], [RideRequestStatus.InProgress]);
      if (!authorized) return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
      const rideId = authorized.ride.id.toLowerCase();
      if (this.pendingTerminations.has(rideId)) return { success: false, reason: 'TERMINATION_PENDING' };
      const term: EarlyTerminationPayload = {
        rideId,
        initiator: authorized.role,
        reason: message.reason.trim().slice(0, 500) || 'Emergency',
        requestedAt: new Date().toISOString(),
        latitude: message.latitude,
        longitude: message.longitude,
      };
      this.pendingTerminations.set(rideId, term);
      this.server?.to(`ride-${rideId}`).emit('RideTerminationRequested', term);
      return { success: true };
    });
  }

  @SubscribeMessage('ResolveTermination')
  async resolveTermination(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    const message = parseResolveTermination(data);
    const rideId = message.rideId;
    const accept = message.accept;
    const raw = Array.isArray(data) ? data[0] : data;
    if (!RIDE_ID_PATTERN.test(rideId) || !raw || typeof raw !== 'object' ||
      typeof (raw as Record<string, unknown>).accept !== 'boolean') {
      return { success: false, reason: 'INVALID_REQUEST' };
    }
    return this.withTerminationLock(rideId, async () => {
      const authorized = await this.authorizeRide(client, rideId, ['rider', 'driver'], [RideRequestStatus.InProgress]);
      if (!authorized) return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
      const canonicalId = authorized.ride.id.toLowerCase();
      const pending = this.pendingTerminations.get(canonicalId);
      if (!pending || pending.initiator === authorized.role) {
        return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
      }
      if (accept) {
        const now = new Date();
        const completion = await this.authorization.completeEarly(authorized.ride, now);
        if (!completion.completed) return { success: false, reason: 'UNAUTHORIZED_OR_INVALID_STATE' };
        this.pendingTerminations.delete(canonicalId);
        if (this.server) {
          this.publishTerminationResolved(canonicalId, true, completion.eventId);
          this.publishRideCompleted(
            authorized.ride.id,
            now,
            Number(authorized.ride.totalAmount ?? authorized.ride.fareAmount),
            authorized.ride.distanceKm == null ? undefined : Number(authorized.ride.distanceKm),
            authorized.ride.riderUserId,
            completion.eventId,
          );
          await this.prisma.outboxEvent.update({
            where: { id: completion.eventId },
            data: { status: 'delivered', deliveredAt: now, processingStartedAt: null },
          });
        }
      } else {
        this.pendingTerminations.delete(canonicalId);
        this.publishTerminationResolved(canonicalId, false);
      }
      return { success: true, accepted: accept };
    });
  }

  // Authoritative publishers
  publishRideAccepted(ride: AcceptedRidePayload, eventId?: string) {
    if (!this.server || !ride?.id) return;
    const payload = {
      ...ride,
      id: ride.id,
      rideId: ride.id,
      ...(eventId ? { eventId } : {}),
    };
    console.log(
      `[RideTrackingGateway] Boundary D: publishRideAccepted emitted for rideId=${ride.id} riderUserId=${ride.riderUserId} driverName=${ride.driverName}`
    );
    const rideIdStr = String(ride.id);
    const lowerRideId = rideIdStr.toLowerCase();
    let broadcaster = this.server.to(`ride-${rideIdStr}`);
    if (lowerRideId !== rideIdStr) {
      broadcaster = broadcaster.to(`ride-${lowerRideId}`);
    }
    if (ride.riderUserId) {
      const riderUserStr = String(ride.riderUserId);
      broadcaster = broadcaster.to(`user-${riderUserStr}`);
      const lowerRiderUser = riderUserStr.toLowerCase();
      if (lowerRiderUser !== riderUserStr) {
        broadcaster = broadcaster.to(`user-${lowerRiderUser}`);
      }
    }
    broadcaster.emit('RideAccepted', payload);
  }

  publishCaptainLocation(
    rideId: string,
    location: CaptainLocationPayload,
    riderUserId?: string | null,
  ) {
    this.lastLocations.set(rideId, location);
    this.emitRide(rideId, 'CaptainLocationUpdated', location, riderUserId);
  }

  publishArrivalConfirmed(rideId: string, riderUserId?: string | null, eventId?: string) {
    if (this.arrivedRides.has(rideId)) return false;
    this.arrivedRides.add(rideId);
    const event = {
      rideId,
      status: 'Assigned',
      arrivedAtPickup: true,
      timestamp: new Date().toISOString(),
      ...(eventId ? { eventId } : {}),
    };
    this.emitRide(rideId, 'CaptainArrivalConfirmed', event, riderUserId);
    return true;
  }

  publishRideStarted(
    rideId: string,
    startedAt?: Date | null,
    riderUserId?: string | null,
    eventId?: string,
  ) {
    const event = {
      rideId,
      status: 'InProgress',
      startedAt: (startedAt ?? new Date()).toISOString(),
      ...(eventId ? { eventId } : {}),
    };
    this.emitRide(rideId, 'RideStarted', event, riderUserId);
  }

  publishRideCompleted(
    rideId: string,
    completedAt?: Date | null,
    fareAmount?: number,
    distanceKm?: number,
    riderUserId?: string | null,
    eventId?: string,
  ) {
    this.arrivedRides.delete(rideId);
    this.pendingTerminations.delete(rideId);
    const event = {
      rideId,
      status: 'Completed',
      completedAt: (completedAt ?? new Date()).toISOString(),
      fareAmount,
      distanceKm,
      ...(eventId ? { eventId } : {}),
    };
    this.emitRide(rideId, 'RideCompleted', event, riderUserId);
  }

  publishFareCollected(
    rideId: string,
    fareAmount: number,
    riderUserId?: string | null,
    eventId?: string,
  ) {
    if (this.collectedRides.has(rideId)) return false;
    this.collectedRides.add(rideId);
    this.emitRide(
      rideId,
      'FareCollected',
      { rideId, fareAmount, collected: true, ...(eventId ? { eventId } : {}) },
      riderUserId,
    );
    return true;
  }

  publishRideCancelled(
    rideId: string,
    cancelledBy: 'rider' | 'driver',
    reason?: string,
    eventId?: string,
  ) {
    this.arrivedRides.delete(rideId);
    this.pendingTerminations.delete(rideId);
    if (!this.server || !rideId) return;
    const event = {
      rideId,
      status: 'Cancelled',
      cancelledBy,
      reason: reason ?? null,
      cancelledAt: new Date().toISOString(),
      ...(eventId ? { eventId } : {}),
    };
    this.server.to(`ride-${rideId}`).emit('RideCancelled', event);
  }

  publishTerminationRequested(
    rideId: string,
    initiator: 'rider' | 'driver',
    reason: string,
    latitude?: number,
    longitude?: number,
  ) {
    const term: EarlyTerminationPayload = {
      rideId,
      initiator,
      reason,
      requestedAt: new Date().toISOString(),
      latitude,
      longitude,
    };
    this.pendingTerminations.set(rideId, term);
    if (!this.server || !rideId) return;
    this.server.to(`ride-${rideId}`).emit('RideTerminationRequested', term);
  }

  publishTerminationResolved(rideId: string, accepted: boolean, eventId?: string) {
    this.pendingTerminations.delete(rideId);
    if (!this.server || !rideId) return;
    this.server.to(`ride-${rideId}`).emit('RideTerminationResolved', {
      rideId,
      accepted,
      completed: accepted,
      ...(eventId ? { eventId } : {}),
    });
  }

  private async buildRideState(rideId: string): Promise<RideStateSnapshot | null> {
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
      include: {
        driver: { include: { user: true, vehicle: true } },
        rider: true,
      },
    });
    if (!ride) return null;

    const loc = this.lastLocations.get(rideId);
    return {
      id: ride.id,
      rideId: ride.id,
      riderUserId: ride.riderUserId,
      status: rideStatusLabel(ride.status),
      arrivedAtPickup: Boolean(ride.driverArrivedAt) || this.arrivedRides.has(ride.id),
      driverId: ride.driverId,
      driverName: ride.driver?.user?.fullName ?? null,
      driverPhone: ride.driver?.user?.phone ?? null,
      driverPhotoUrl: ride.driver?.user?.avatarUrl ?? null,
      driverRatingAverage: ride.driver?.ratingAverage != null ? Number(ride.driver.ratingAverage) : null,
      driverRatingCount: ride.driver?.ratingCount ?? null,
      vehicleKind: ride.driver?.vehicleKind ?? (ride.driver?.vehicle ? String(ride.driver.vehicle.type) : null),
      vehicleModel: ride.driver?.vehicleModelName ?? ride.driver?.vehicle?.model ?? null,
      vehicleColor: ride.driver?.vehicleColor ?? null,
      plateNumber: ride.driver?.plateNumber ?? ride.driver?.vehicle?.plateNumber ?? null,
      pickupLatitude: ride.pickupLatitude,
      pickupLongitude: ride.pickupLongitude,
      pickupAddress: ride.pickupAddress,
      destinationLatitude: ride.destinationLatitude,
      destinationLongitude: ride.destinationLongitude,
      destinationAddress: ride.destinationAddress,
      fareAmount: Number(ride.fareAmount),
      distanceKm: ride.distanceKm != null ? Number(ride.distanceKm) : null,
      captainLatitude: loc?.latitude ?? null,
      captainLongitude: loc?.longitude ?? null,
      captainLocationUpdatedAt: loc?.timestamp ?? null,
      fareCollected: this.collectedRides.has(ride.id),
      assignedAt: ride.assignedAt?.toISOString() ?? null,
      startedAt: ride.startedAt?.toISOString() ?? null,
      completedAt: ride.completedAt?.toISOString() ?? null,
      cancelledAt: ride.cancelledAt?.toISOString() ?? null,
      pendingTermination: this.pendingTerminations.get(ride.id) ?? null,
    };
  }
}
