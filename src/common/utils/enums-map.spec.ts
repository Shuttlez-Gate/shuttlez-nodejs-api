import { VehicleType } from '../enums';
import { parseVehicleType, vehicleKindFamily, vehicleTypeLabel } from './enums-map';

describe('parseVehicleType', () => {
  it('parses scooter', () => {
    expect(parseVehicleType('scooter')).toBe(VehicleType.Scooter);
    expect(parseVehicleType('4')).toBe(VehicleType.Scooter);
    expect(vehicleTypeLabel(VehicleType.Scooter)).toBe('Scooter');
  });

  it('keeps car as the default', () => {
    expect(parseVehicleType('carshuttle')).toBe(VehicleType.CarShuttle);
    expect(parseVehicleType('unknown')).toBe(VehicleType.CarShuttle);
  });
});

describe('vehicleKindFamily', () => {
  it('separates car captains from scooter captains', () => {
    expect(vehicleKindFamily('CarShuttle')).toBe('car');
    expect(vehicleKindFamily('scooter')).toBe('scooter');
  });
});
