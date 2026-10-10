import { DeviceCheckError } from './errors.js';

export interface DeviceRow {
  id: string;
  name: string;
  hardware: string;
  created: string;
  accessed: string;
}
export interface DeviceSnapshot {
  counter: string;
  rows: DeviceRow[];
  browserSessions: number;
}
export interface DeviceReport {
  count: number;
  limit: number;
  browserSessions: number;
  devices: DeviceRow[];
  cleanupCandidates: DeviceRow[];
}
const months = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function invalid(message: string): never {
  throw new DeviceCheckError('PAGE_CHANGED', message);
}

function registrationOrder(text: string): number {
  const match = /^Добавлен:\s*(\d{1,2}) ([A-Za-z]+) (\d{4}) в (\d{2}):(\d{2})$/.exec(text.trim().replace(/\s+/g, ' '));
  if (!match) return invalid('Unrecognized registration date; cannot determine FIFO order.');
  const day = Number(match[1]);
  const month = months.indexOf(match[2]!);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  // Compare displayed local times consistently without guessing the account timezone.
  // This numeric key is never exposed as an actual UTC event timestamp.
  const key = Date.UTC(year, month, day, hour, minute);
  const date = new Date(key);
  if (year < 2000 || month < 0 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    return invalid('Invalid registration date; cannot determine FIFO order.');
  }
  return key;
}

export function buildDeviceReport(snapshot: DeviceSnapshot): DeviceReport {
  const match = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/.exec(snapshot.counter);
  if (!match) return invalid('Device counter is missing or unrecognized.');
  const count = Number(match[1]);
  const limit = Number(match[2]);
  if (limit !== 5 || count > limit || count !== snapshot.rows.length) {
    return invalid('Device counter and app registrations disagree, or capacity has changed.');
  }
  const ids = new Set<string>();
  const ordered = snapshot.rows.map(row => {
    if (!/^\d+$/.test(row.id) || ids.has(row.id)) {
      return invalid('Missing, invalid, or duplicate app device identifier.');
    }
    ids.add(row.id);
    return { row: { ...row }, order: registrationOrder(row.created) };
  }).sort((a, b) => a.order - b.order || a.row.id.localeCompare(b.row.id, 'en', {numeric: true}));
  const devices = ordered.map(item => item.row);
  return {
    count, limit, browserSessions: snapshot.browserSessions, devices,
    cleanupCandidates: devices.slice(0, Math.max(0, count - 2)),
  };
}
