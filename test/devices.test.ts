import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeviceReport, type DeviceRow } from '../src/devices.js';

function row(id: string, created: string): DeviceRow {
  return { id, name: 'Test TV', hardware: 'Test hardware', created, accessed: 'Активность: 08 October 2026 в 22:25' };
}
const rows = [
  row('104', 'Добавлен: 07 October 2026 в 22:03'),
  row('102', 'Добавлен: 12 September 2026 в 21:39'),
  row('101', 'Добавлен: 22 May 2026 в 15:30'),
  row('103', 'Добавлен: 19 September 2026 в 18:06'),
  row('105', 'Добавлен: 08 October 2026 в 22:30'),
];

test('up to two registrations need no cleanup for the next registration', () => {
  for (const count of [0, 1, 2]) {
    const result = buildDeviceReport({counter: `Устройства (${count}/5)`, rows: rows.slice(0,count), browserSessions: 5});
    assert.equal(result.count, count);
    assert.equal(result.browserSessions, 5);
    assert.deepEqual(result.cleanupCandidates, []);
  }
});
test('three to five registrations select enough oldest devices to finish the next registration at three', () => {
  for (const count of [3, 4, 5]) {
    const input = rows.slice(0,count);
    const result = buildDeviceReport({counter: `Устройства (${count}/5)`, rows: input, browserSessions: 5});
    assert.deepEqual(result.cleanupCandidates.map(d => d.id), ['101','102','103'].slice(0,count-2));
    assert.equal(input[0]?.id, '104');
  }
});
test('refuses a stale counter or unexpected device limit', () => {
  for (const counter of ['Устройства (4/5)', 'Устройства (2/6)', 'garbled']) {
    assert.throws(() => buildDeviceReport({counter,rows:rows.slice(0,2),browserSessions:0}), {code:'PAGE_CHANGED'});
  }
});
test('refuses missing or duplicate IDs instead of suggesting unsafe cleanup', () => {
  for (const invalid of [[row('', 'Добавлен: 07 October 2026 в 22:03')], [rows[0]!, rows[0]!]]) {
    assert.throws(() => buildDeviceReport({counter:`Устройства (${invalid.length}/5)`,rows:invalid,browserSessions:0}), {code:'PAGE_CHANGED'});
  }
});
test('refuses impossible dates rather than silently normalizing them', () => {
  for (const date of ['Добавлен: 31 February 2026 в 12:00', 'Добавлен: 07 October 2026 в 25:00', '', 'yesterday']) {
    assert.throws(() => buildDeviceReport({counter:'Устройства (1/5)',rows:[row('100',date)],browserSessions:0}), {code:'PAGE_CHANGED'});
  }
});
