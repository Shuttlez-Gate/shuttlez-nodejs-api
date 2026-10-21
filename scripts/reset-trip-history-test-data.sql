-- Review-only cleanup for obsolete trip test data.
-- Do not run this until the connection target is confirmed.
-- It refuses to run unless the same session sets:
--   SET shuttlez.reset_trip_test_data = 'yes';
--
-- Deletes operational trip rows only. It does not touch users, drivers,
-- refresh tokens, routes, stops, pricing, wallets, or support tickets.
--
-- Order follows foreign keys:
--   InvoicesSet
--   CancellationRequestsSet
--   TripSegmentInventorySet
--   ReviewsSet
--   GroupMemberMessagesSet
--   GroupMembersSet
--   BookingsSet
--   GroupRequestsSet
--   RideRequestsSet
--   TripsSet
--   TripHistoryReadModel

DO $$
BEGIN
  IF current_setting('shuttlez.reset_trip_test_data', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION
      'Refused. Confirm current_database() and inet_server_addr(), then SET shuttlez.reset_trip_test_data = ''yes'' in this session.';
  END IF;
END $$;

BEGIN;

DELETE FROM "InvoicesSet";
DELETE FROM "CancellationRequestsSet";
DELETE FROM "TripSegmentInventorySet";
DELETE FROM "ReviewsSet";
DELETE FROM "GroupMemberMessagesSet";
DELETE FROM "GroupMembersSet";
DELETE FROM "BookingsSet";
DELETE FROM "GroupRequestsSet";
DELETE FROM "RideRequestsSet";
DELETE FROM "TripsSet";
DELETE FROM "TripHistoryReadModel";

COMMIT;
