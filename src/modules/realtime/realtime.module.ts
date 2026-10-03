import { Module } from '@nestjs/common';
import {
  DriverGateway,
  GroupGateway,
  SupportChatGateway,
  TripTrackingGateway,
} from './realtime.gateway';

@Module({
  providers: [
    TripTrackingGateway,
    SupportChatGateway,
    DriverGateway,
    GroupGateway,
  ],
  exports: [SupportChatGateway, GroupGateway],
})
export class RealtimeModule {}
