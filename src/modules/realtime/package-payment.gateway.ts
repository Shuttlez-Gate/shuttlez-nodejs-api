import {
  ConnectedSocket,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SocketIdentity } from './socket-identity';

export type PackagePaymentUpdate = {
  purchaseId: string;
  status: string;
  packageName: string;
  message: string;
  reason?: string | null;
};

@WebSocketGateway({
  path: '/hubs/package-payments',
  cors: { origin: true, credentials: true },
})
export class PackagePaymentGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly identity: SocketIdentity) {}

  async handleConnection(client: Socket): Promise<void> {
    await this.joinUser(client);
  }

  @SubscribeMessage('JoinPackagePayments')
  async join(@ConnectedSocket() client: Socket): Promise<void> {
    await this.joinUser(client);
  }

  publish(userId: string, payload: PackagePaymentUpdate): void {
    const room = this.room(userId);
    if (!this.server || !room) return;
    this.server.to(room).emit('PackagePaymentUpdated', payload);
  }

  private async joinUser(client: Socket): Promise<void> {
    const userId = await this.identity.userId(client);
    if (!userId) {
      client.disconnect(true);
      return;
    }
    await client.join(this.room(userId));
  }

  private room(userId: string): string {
    const id = userId.trim().toLowerCase();
    return id ? `user-${id}` : '';
  }
}
