import { Module } from '@nestjs/common';
import { PackagePaymentGateway } from './package-payment.gateway';
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
    PackagePaymentGateway,
  ],
  exports: [
    SupportChatGateway,
    GroupGateway,
    RiderHistoryGateway,
    DriverGateway,
    RideTrackingGateway,
    TripTrackingGateway,
    PackagePaymentGateway,
  ],
})
export class RealtimeModule {}
