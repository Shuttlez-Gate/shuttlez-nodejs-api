import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [HealthController],
})
export class HealthModule {}
