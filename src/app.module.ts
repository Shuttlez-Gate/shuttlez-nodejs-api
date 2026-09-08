import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContentModule } from './modules/content/content.module';
import { LandingModule } from './modules/landing/landing.module';
import { CoreApiModule } from './modules/core/core-api.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    PrismaModule,
    CommonModule,
    HealthModule,
    AuthModule,
    ContentModule,
    LandingModule,
    CoreApiModule,
    RealtimeModule,
  ],
})
export class AppModule {}
