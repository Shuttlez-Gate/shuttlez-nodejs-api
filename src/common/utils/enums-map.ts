import {
  BookingStatus,
  DriverDocumentType,
  DriverVerificationStatus,
  GroupRequestStatus,
  RideRequestStatus,
  TripStatus,
  UserType,
  VehicleType,
} from '../enums';

export function parseUserType(raw?: string | null): number {
  switch ((raw ?? 'passenger').trim().toLowerCase()) {
    case 'driver':
    case 'captain':
      return UserType.Driver;
    case 'admin':
      return UserType.Admin;
    default:
      return UserType.Passenger;
  }
}

export function userTypeLabel(value: number): string {
  switch (value) {
    case UserType.Driver:
      return 'Driver';
    case UserType.Admin:
      return 'Admin';
    default:
      return 'Passenger';
  }
}

export function parseVehicleType(raw?: string | null): number {
  const key = (raw ?? '').trim().toLowerCase();
  if (['minibus', 'mini-bus', 'mini_bus', '2'].includes(key)) {
    return VehicleType.MiniBus;
  }
  if (['bus', '3'].includes(key)) {
    return VehicleType.Bus;
  }
  return VehicleType.CarShuttle;
}

export function vehicleTypeLabel(value: number): string {
  switch (value) {
    case VehicleType.MiniBus:
      return 'MiniBus';
    case VehicleType.Bus:
      return 'Bus';
    default:
      return 'CarShuttle';
  }
}

export function parseTripStatus(raw?: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const map: Record<string, number> = {
    scheduled: TripStatus.Scheduled,
    '1': TripStatus.Scheduled,
    driverassigned: TripStatus.DriverAssigned,
    assigned: TripStatus.DriverAssigned,
    '2': TripStatus.DriverAssigned,
    inprogress: TripStatus.InProgress,
    '3': TripStatus.InProgress,
    completed: TripStatus.Completed,
    '4': TripStatus.Completed,
    cancelled: TripStatus.Cancelled,
    canceled: TripStatus.Cancelled,
    '5': TripStatus.Cancelled,
  };
  return map[key.replace(/[\s_-]/g, '')];
}

export function tripStatusLabel(value: number): string {
  switch (value) {
    case TripStatus.DriverAssigned:
      return 'DriverAssigned';
    case TripStatus.InProgress:
      return 'InProgress';
    case TripStatus.Completed:
      return 'Completed';
    case TripStatus.Cancelled:
      return 'Cancelled';
    default:
      return 'Scheduled';
  }
}

export function parseBookingStatus(raw?: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const map: Record<string, number> = {
    pending: BookingStatus.Pending,
    confirmed: BookingStatus.Confirmed,
    cancelled: BookingStatus.Cancelled,
    canceled: BookingStatus.Cancelled,
    expired: BookingStatus.Expired,
  };
  return map[key];
}

export function bookingStatusLabel(value: number): string {
  switch (value) {
    case BookingStatus.Confirmed:
      return 'Confirmed';
    case BookingStatus.Cancelled:
      return 'Cancelled';
    case BookingStatus.Expired:
      return 'Expired';
    default:
      return 'Pending';
  }
}

export function rideStatusLabel(value: number): string {
  switch (value) {
    case RideRequestStatus.Assigned:
      return 'Assigned';
    case RideRequestStatus.InProgress:
      return 'InProgress';
    case RideRequestStatus.Completed:
      return 'Completed';
    case RideRequestStatus.Cancelled:
      return 'Cancelled';
    default:
      return 'Requested';
  }
}

export function parseRideStatus(raw?: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const map: Record<string, number> = {
    requested: RideRequestStatus.Requested,
    assigned: RideRequestStatus.Assigned,
    inprogress: RideRequestStatus.InProgress,
    completed: RideRequestStatus.Completed,
    cancelled: RideRequestStatus.Cancelled,
    canceled: RideRequestStatus.Cancelled,
  };
  return map[raw.trim().toLowerCase().replace(/[\s_-]/g, '')];
}

export function groupStatusLabel(value: number): string {
  switch (value) {
    case GroupRequestStatus.Confirmed:
      return 'Confirmed';
    case GroupRequestStatus.Assigned:
      return 'Assigned';
    case GroupRequestStatus.InProgress:
      return 'InProgress';
    case GroupRequestStatus.Completed:
      return 'Completed';
    case GroupRequestStatus.Cancelled:
      return 'Cancelled';
    default:
      return 'Draft';
  }
}

export function parseGroupStatus(raw?: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const map: Record<string, number> = {
    draft: GroupRequestStatus.Draft,
    confirmed: GroupRequestStatus.Confirmed,
    assigned: GroupRequestStatus.Assigned,
    inprogress: GroupRequestStatus.InProgress,
    completed: GroupRequestStatus.Completed,
    cancelled: GroupRequestStatus.Cancelled,
    canceled: GroupRequestStatus.Cancelled,
  };
  return map[raw.trim().toLowerCase().replace(/[\s_-]/g, '')];
}

export function verificationLabel(value: number): string {
  switch (value) {
    case DriverVerificationStatus.Approved:
      return 'Approved';
    case DriverVerificationStatus.Rejected:
      return 'Rejected';
    default:
      return 'Pending';
  }
}

export function parseVerification(raw?: string | null): number {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'approved':
      return DriverVerificationStatus.Approved;
    case 'rejected':
      return DriverVerificationStatus.Rejected;
    default:
      return DriverVerificationStatus.Pending;
  }
}

export function parseDocumentType(raw?: string | null): number {
  const map: Record<string, number> = {
    personalphoto: DriverDocumentType.PersonalPhoto,
    nationalid: DriverDocumentType.NationalId,
    license: DriverDocumentType.License,
    vehiclefront: DriverDocumentType.VehicleFront,
    vehiclerear: DriverDocumentType.VehicleRear,
    vehiclelicense: DriverDocumentType.VehicleLicense,
    insurance: DriverDocumentType.Insurance,
    inspection: DriverDocumentType.Inspection,
    other: DriverDocumentType.Other,
  };
  return map[(raw ?? 'other').trim().toLowerCase().replace(/[\s_-]/g, '')] ?? DriverDocumentType.Other;
}

export function documentTypeLabel(value: number): string {
  const map: Record<number, string> = {
    [DriverDocumentType.PersonalPhoto]: 'PersonalPhoto',
    [DriverDocumentType.NationalId]: 'NationalId',
    [DriverDocumentType.License]: 'License',
    [DriverDocumentType.VehicleFront]: 'VehicleFront',
    [DriverDocumentType.VehicleRear]: 'VehicleRear',
    [DriverDocumentType.VehicleLicense]: 'VehicleLicense',
    [DriverDocumentType.Insurance]: 'Insurance',
    [DriverDocumentType.Inspection]: 'Inspection',
  };
  return map[value] ?? 'Other';
}

export function invoiceStatusLabel(value: number): string {
  switch (value) {
    case 2:
      return 'Paid';
    case 3:
      return 'Failed';
    case 4:
      return 'Refunded';
    default:
      return 'Pending';
  }
}
