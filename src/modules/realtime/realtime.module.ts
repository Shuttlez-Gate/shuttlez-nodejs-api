import { Module } from '@nestjs/common';
import {
  DriverGateway,
  GroupGateway,
  RiderHistoryGateway,
  RideTrackingGateway,
  SupportChatGateway,
  TripTrackingGateway,
} from './realtime.gateway';
import { SocketIdentity } from './socket-identity';
import { TripLiveController } from './trip-live.controller';

@Module({
  controllers: [TripLiveController],
  providers: [
    SocketIdentity,
    TripTrackingGateway,
    RideTrackingGateway,
    SupportChatGateway,
    DriverGateway,
    GroupGateway,
    RiderHistoryGateway,
  ],
  exports: [
    SupportChatGateway,
    GroupGateway,
    RiderHistoryGateway,
    DriverGateway,
    RideTrackingGateway,
    TripTrackingGateway,
  ],
})
export class RealtimeModule {}
