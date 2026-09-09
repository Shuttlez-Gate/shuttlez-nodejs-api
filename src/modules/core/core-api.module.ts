import { Module } from '@nestjs/common';
import { SavedLocationsController } from '../saved-locations/saved-locations.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { CustomerTripsController, RoutesController } from '../routes/routes.controller';
import { AuthModule } from '../auth/auth.module';
import { LandingModule } from '../landing/landing.module';
import { FareService } from '../pricing/fare.service';
import { RidesService } from '../rides/rides.service';
import { RidesController } from '../rides/rides.controller';
import { GroupsService } from '../groups/groups.service';
import { GroupsController } from '../groups/groups.controller';
import { DriversService } from '../drivers/drivers.service';
import { DriversController } from '../drivers/drivers.controller';
import {
  BookingsController,
  SubscriptionPackagesController,
  TripsController,
} from '../bookings/bookings.controller';
import {
  RouteRequestsController,
  SupportController,
} from '../support/support.controller';
import {
  AdminDriversController,
  AdminUsersController,
  AdminVehiclesController,
} from '../admin/admin-users.controller';
import {
  AdminBookingsController,
  AdminLeadsController,
  AdminReviewsController,
  AdminRouteRequestsController,
  AdminRoutesController,
  AdminTripsController,
} from '../admin/admin-operations.controller';
import {
  AdminCommissionController,
  AdminEarningsController,
  AdminFaqController,
  AdminLegalController,
  AdminPackagesController,
  AdminPricingController,
} from '../admin/admin-content.controller';
import {
  AdminGroupFareController,
  AdminRideFareController,
} from '../admin/admin-fares.controller';
import { AdminRouteDemandController } from '../admin/admin-demand.controller';
import { RouteDemandService } from '../admin/route-demand/route-demand.service';
import { CorridorDemandService } from '../admin/corridor-demand.service';
import { AdminDashboardService } from '../admin/dashboard.service';
import {
  AdminDashboardController,
  AdminGroupsController,
  AdminNotificationsController,
  AdminRidesController,
  AdminSupportController,
} from '../admin/admin-support.controller';

@Module({
  imports: [AuthModule, LandingModule],
  controllers: [
    SavedLocationsController,
    NotificationsController,
    RoutesController,
    CustomerTripsController,
    RidesController,
    GroupsController,
    DriversController,
    BookingsController,
    TripsController,
    SubscriptionPackagesController,
    SupportController,
    RouteRequestsController,
    AdminUsersController,
    AdminVehiclesController,
    AdminDriversController,
    AdminRoutesController,
    AdminTripsController,
    AdminBookingsController,
    AdminReviewsController,
    AdminRouteRequestsController,
    AdminLeadsController,
    AdminFaqController,
    AdminLegalController,
    AdminPackagesController,
    AdminCommissionController,
    AdminPricingController,
    AdminEarningsController,
    AdminRideFareController,
    AdminGroupFareController,
    AdminRouteDemandController,
    AdminSupportController,
    AdminNotificationsController,
    AdminRidesController,
    AdminGroupsController,
    AdminDashboardController,
  ],
  providers: [
    FareService,
    RidesService,
    GroupsService,
    DriversService,
    RouteDemandService,
    CorridorDemandService,
    AdminDashboardService,
  ],
})
export class CoreApiModule {}
