import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

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

@WebSocketGateway({
  path: '/hubs/support-chat',
  cors: { origin: true, credentials: true },
})
export class SupportChatGateway {
  @SubscribeMessage('JoinTicket')
  async join(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    if (!ticketId?.trim()) {
      return;
    }
    await client.join(`ticket-${ticketId.trim()}`);
  }

  @SubscribeMessage('LeaveTicket')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    if (!ticketId?.trim()) {
      return;
    }
    await client.leave(`ticket-${ticketId.trim()}`);
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
