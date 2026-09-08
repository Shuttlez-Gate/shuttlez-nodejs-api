import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppExceptionFilter } from './filters/app-exception.filter';
import { OptionalJwtGuard } from './guards/optional-jwt.guard';
import { AdminOnlyGuard } from './guards/admin-only.guard';
import { CurrentUserService } from './current-user.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [
    CurrentUserService,
    AdminOnlyGuard,
    OptionalJwtGuard,
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: OptionalJwtGuard },
  ],
  exports: [CurrentUserService, JwtModule, AdminOnlyGuard],
})
export class CommonModule {}
