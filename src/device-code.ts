const DEVICE_CODE_PATTERN = /^[A-Za-z0-9]{5}$/;

export function normalizeDeviceCode(value: string): string {
  return value.trim().replace(/\p{Cf}/gu, '');
}

export function isDeviceCode(value: string): boolean {
  return DEVICE_CODE_PATTERN.test(value);
}
