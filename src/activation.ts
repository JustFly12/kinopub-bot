import type { DeviceReport } from './devices.js';
import { isDeviceCode } from './device-code.js';
import { DeviceCheckError } from './errors.js';

export interface ActivationPlan {
  baselineDeviceIds: string[];
  plannedRemovalIds: string[];
  removedDeviceIds: string[];
  activationSubmitted: boolean;
}

export interface ActivationState {
  activationPlan?: ActivationPlan;
}

export interface ActivationSession {
  inspect(): Promise<DeviceReport>;
  removeDevice(id: string): Promise<DeviceReport>;
  activateDevice(code: string): Promise<DeviceReport>;
}

export interface ActivationResult {
  report: DeviceReport;
  removedDeviceIds: string[];
  reconciledPreviousActivation: boolean;
}

export async function activateWithCleanup(
  session: ActivationSession,
  state: ActivationState,
  saveState: () => Promise<void>,
  code: string,
): Promise<ActivationResult> {
  if (!isDeviceCode(code)) {
    throw new DeviceCheckError('INVALID_DEVICE_CODE', 'Device code must contain exactly five alphanumeric characters.');
  }
  let report = await session.inspect();
  if (!state.activationPlan) {
    state.activationPlan = {
      baselineDeviceIds: report.devices.map(device => device.id),
      plannedRemovalIds: report.cleanupCandidates.map(device => device.id),
      removedDeviceIds: [],
      activationSubmitted: false,
    };
    await saveState();
  }
  const plan = state.activationPlan;
  if (plan.activationSubmitted) {
    const baseline = new Set(plan.baselineDeviceIds);
    if (report.devices.some(device => !baseline.has(device.id))) {
      const removedDeviceIds = [...plan.removedDeviceIds];
      delete state.activationPlan;
      await saveState();
      return {report, removedDeviceIds, reconciledPreviousActivation: true};
    }
    plan.activationSubmitted = false;
    await saveState();
  }
  const currentIds = new Set(report.devices.map(device => device.id));
  for (const id of plan.plannedRemovalIds) {
    if (!currentIds.has(id) && !plan.removedDeviceIds.includes(id)) plan.removedDeviceIds.push(id);
  }
  await saveState();
  for (const id of plan.plannedRemovalIds) {
    if (plan.removedDeviceIds.includes(id)) continue;
    report = await session.removeDevice(id);
    if (report.devices.some(device => device.id === id)) {
      throw new DeviceCheckError('REMOVAL_UNCONFIRMED', `Device ${id} still appears after removal.`);
    }
    plan.removedDeviceIds.push(id);
    await saveState();
  }
  plan.activationSubmitted = true;
  await saveState();
  report = await session.activateDevice(code);
  const removedDeviceIds = [...plan.removedDeviceIds];
  delete state.activationPlan;
  await saveState();
  return {report, removedDeviceIds, reconciledPreviousActivation: false};
}
