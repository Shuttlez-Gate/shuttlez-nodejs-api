export function baseFields(now = new Date()) {
  return {
    createdAt: now,
    isDeleted: false,
  };
}

export function userDefaults(now = new Date()) {
  return {
    ...baseFields(now),
    ratingAverage: 0,
    ratingCount: 0,
    isActive: true,
  };
}

export function driverDefaults(now = new Date()) {
  return {
    ...baseFields(now),
    ratingAverage: 0,
    ratingCount: 0,
    isOnline: false,
  };
}

export function walletDefaults(now = new Date()) {
  return {
    ...baseFields(now),
    currency: 'EGP',
    balance: 0,
  };
}
