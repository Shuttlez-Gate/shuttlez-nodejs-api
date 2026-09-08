import { Module } from '@nestjs/common';
import {
  DriverGateway,
  SupportChatGateway,
  TripTrackingGateway,
} from './realtime.gateway';

@Module({
  providers: [TripTrackingGateway, SupportChatGateway, DriverGateway],
})
export class RealtimeModule {}
