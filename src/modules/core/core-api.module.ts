import { Module } from '@nestjs/common';
import { SavedLocationsController } from '../saved-locations/saved-locations.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { CustomerTripsController, RoutesController } from '../routes/routes.controller';
import { AuthModule } from '../auth/auth.module';
import { RemainingApiController } from './remaining-api.controller';

@Module({
  imports: [AuthModule],
  controllers: [
    SavedLocationsController,
    NotificationsController,
    RoutesController,
    CustomerTripsController,
    RemainingApiController,
  ],
})
export class CoreApiModule {}
