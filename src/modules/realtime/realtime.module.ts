import { Module } from '@nestjs/common';
import {
  DriverGateway,
  GroupGateway,
  RiderHistoryGateway,
  SupportChatGateway,
  TripTrackingGateway,
} from './realtime.gateway';

@Module({
  providers: [
    TripTrackingGateway,
    SupportChatGateway,
    DriverGateway,
    GroupGateway,
    RiderHistoryGateway,
  ],
  exports: [SupportChatGateway, GroupGateway, RiderHistoryGateway],
})
export class RealtimeModule {}
