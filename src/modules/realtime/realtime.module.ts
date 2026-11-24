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
import { RideTrackingAuthorizationService } from './ride-tracking.authorization';
import { RideOutboxService } from './ride-outbox.service';
import { SocketIoReadinessService } from './socket-io-readiness.service';

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
    RideTrackingAuthorizationService,
    RideOutboxService,
    SocketIoReadinessService,
  ],
  exports: [
    SupportChatGateway,
    GroupGateway,
    RiderHistoryGateway,
    DriverGateway,
    RideTrackingGateway,
    TripTrackingGateway,
    PackagePaymentGateway,
    RideOutboxService,
    SocketIoReadinessService,
  ],
})
export class RealtimeModule {}
