export type CaptainStopInput = {
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  source?: string | null;
  order?: number | null;
};

export type NormalizedCaptainStop = {
  name: string;
  latitude: number | null;
  longitude: number | null;
  source: 'map' | 'search' | 'manual';
  order: number;
};

export function hasPinnedCoords(
  latitude?: number | null,
  longitude?: number | null,
): boolean {
  return (
    latitude != null &&
    longitude != null &&
    Number.isFinite(Number(latitude)) &&
    Number.isFinite(Number(longitude)) &&
    !(Number(latitude) === 0 && Number(longitude) === 0)
  );
}

export function samePinnedPoint(
  a: { latitude?: number | null; longitude?: number | null },
  b: { latitude?: number | null; longitude?: number | null },
): boolean {
  if (!hasPinnedCoords(a.latitude, a.longitude) || !hasPinnedCoords(b.latitude, b.longitude)) {
    return false;
  }
  return (
    Math.abs(Number(a.latitude) - Number(b.latitude)) < 1e-5 &&
    Math.abs(Number(a.longitude) - Number(b.longitude)) < 1e-5
  );
}

function stopSource(
  raw: string | null | undefined,
  pinned: boolean,
): 'map' | 'search' | 'manual' {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === 'map' || key === 'search' || key === 'manual') {
    return key;
  }
  return pinned ? 'map' : 'manual';
}

export function normalizeCaptainStops(stops: CaptainStopInput[] | undefined): NormalizedCaptainStop[] {
  const cleaned = (stops ?? [])
    .map((stop, index) => {
      const name = (stop.name ?? '').trim();
      const pinned = hasPinnedCoords(stop.latitude, stop.longitude);
      return {
        name,
        latitude: pinned ? Number(stop.latitude) : null,
        longitude: pinned ? Number(stop.longitude) : null,
        source: stopSource(stop.source, pinned),
        order: Number.isInteger(stop.order) ? Number(stop.order) : index,
      };
    })
    .filter((stop) => stop.name.length > 0)
    .sort((a, b) => a.order - b.order)
    .map((stop, index) => ({ ...stop, order: index }));

  if (cleaned.length < 2) {
    throw new Error('أضف نقطة الانطلاق والوجهة على الأقل');
  }

  const origin = cleaned[0];
  const destination = cleaned[cleaned.length - 1];
  if (!hasPinnedCoords(origin.latitude, origin.longitude)) {
    throw new Error('حدد نقطة الانطلاق من الخريطة أو البحث');
  }
  if (!hasPinnedCoords(destination.latitude, destination.longitude)) {
    throw new Error('حدد الوجهة من الخريطة أو البحث');
  }
  if (samePinnedPoint(origin, destination)) {
    throw new Error('نقطة الانطلاق والوجهة يجب أن تكونا مختلفتين');
  }

  const intermediates = cleaned.slice(1, -1);
  for (const stop of intermediates) {
    if (!stop.name) {
      throw new Error('اسم المحطة مطلوب');
    }
    if (
      (stop.latitude == null) !== (stop.longitude == null) ||
      (stop.latitude != null && !Number.isFinite(stop.latitude)) ||
      (stop.longitude != null && !Number.isFinite(stop.longitude))
    ) {
      throw new Error('إحداثيات المحطة غير صالحة');
    }
  }

  return cleaned;
}

export function persistStopCoords(stop: { latitude: number | null; longitude: number | null }) {
  if (hasPinnedCoords(stop.latitude, stop.longitude)) {
    return { latitude: Number(stop.latitude), longitude: Number(stop.longitude) };
  }
  return { latitude: 0, longitude: 0 };
}

export function publicStopCoords(stop: { latitude?: number | null; longitude?: number | null }) {
  if (!hasPinnedCoords(stop.latitude, stop.longitude)) {
    return { latitude: null as number | null, longitude: null as number | null };
  }
  return { latitude: Number(stop.latitude), longitude: Number(stop.longitude) };
}
