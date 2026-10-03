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

export type GroupUpdatedPayload = {
  id: string;
  organizerUserId: string;
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
        OR: [{ id }, { referenceCode: id }],
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
