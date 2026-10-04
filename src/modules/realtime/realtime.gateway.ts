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

@WebSocketGateway({
  path: '/hubs/trip-tracking',
  cors: { origin: true, credentials: true },
})
export class TripTrackingGateway {
  @WebSocketServer()
  server!: Server;

  @SubscribeMessage('JoinTrip')
  async join(@ConnectedSocket() client: Socket, @MessageBody() tripId: string) {
    await client.join(`trip-${tripId}`);
  }

  @SubscribeMessage('LeaveTrip')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() tripId: string) {
    await client.leave(`trip-${tripId}`);
  }

  @SubscribeMessage('BroadcastDriverLocation')
  async location(
    @MessageBody()
    payload: { tripId: string; latitude: number; longitude: number },
  ) {
    this.server.to(`trip-${payload.tripId}`).emit('DriverLocationUpdated', {
      tripId: payload.tripId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      timestamp: new Date().toISOString(),
    });
  }
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
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('JoinTicket')
  async join(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    const id = ticketId?.trim();
    const token = String(client.handshake.auth?.token ?? '').trim();
    if (!id || !token) return;
    let userId = '';
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      userId = payload.sub ?? '';
    } catch {
      return;
    }
    if (!userId) return;
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, userId, isDeleted: false },
      select: { id: true },
    });
    if (!ticket) return;
    await client.join(`ticket-${ticket.id}`);
  }

  @SubscribeMessage('LeaveTicket')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    if (!ticketId?.trim()) {
      return;
    }
    await client.leave(`ticket-${ticketId.trim()}`);
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
  path: '/hubs/driver',
  cors: { origin: true, credentials: true },
})
export class DriverGateway {
  @SubscribeMessage('JoinDriverRoom')
  async join(@ConnectedSocket() client: Socket) {
    const userId =
      (client.handshake.auth?.userId as string | undefined) ??
      (client.handshake.query.userId as string | undefined);
    if (userId) {
      await client.join(`driver-${userId}`);
    }
  }
}
