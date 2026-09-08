export const UserType = {
  Passenger: 1,
  Driver: 2,
  Admin: 3,
} as const;
export type UserType = (typeof UserType)[keyof typeof UserType];

export const Gender = {
  Male: 1,
  Female: 2,
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

export const VehicleType = {
  CarShuttle: 1,
  MiniBus: 2,
  Bus: 3,
} as const;
export type VehicleType = (typeof VehicleType)[keyof typeof VehicleType];

export const TripStatus = {
  Scheduled: 1,
  DriverAssigned: 2,
  InProgress: 3,
  Completed: 4,
  Cancelled: 5,
} as const;
export type TripStatus = (typeof TripStatus)[keyof typeof TripStatus];

export const BookingStatus = {
  Pending: 1,
  Confirmed: 2,
  Cancelled: 3,
  Expired: 4,
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const PaymentStatus = {
  Pending: 1,
  Paid: 2,
  Failed: 3,
  Refunded: 4,
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const OtpPurpose = {
  Login: 1,
  Register: 2,
  SocialLink: 3,
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

export const DriverVerificationStatus = {
  Pending: 0,
  Approved: 1,
  Rejected: 2,
} as const;
export type DriverVerificationStatus =
  (typeof DriverVerificationStatus)[keyof typeof DriverVerificationStatus];

export const DriverDocumentType = {
  PersonalPhoto: 0,
  NationalId: 1,
  License: 2,
  VehicleFront: 3,
  VehicleRear: 4,
  VehicleLicense: 5,
  Insurance: 6,
  Inspection: 7,
  Other: 99,
} as const;
export type DriverDocumentType =
  (typeof DriverDocumentType)[keyof typeof DriverDocumentType];

export const RideRequestStatus = {
  Requested: 1,
  Assigned: 2,
  InProgress: 3,
  Completed: 4,
  Cancelled: 5,
} as const;
export type RideRequestStatus =
  (typeof RideRequestStatus)[keyof typeof RideRequestStatus];

export const GroupRequestStatus = {
  Draft: 1,
  Confirmed: 2,
  Assigned: 3,
  InProgress: 4,
  Completed: 5,
  Cancelled: 6,
} as const;
export type GroupRequestStatus =
  (typeof GroupRequestStatus)[keyof typeof GroupRequestStatus];

export function userTypeName(value: number): string {
  switch (value) {
    case UserType.Driver:
      return 'Driver';
    case UserType.Admin:
      return 'Admin';
    default:
      return 'Passenger';
  }
}

export function userTypeNameLower(value: number): string {
  return userTypeName(value).toLowerCase();
}
