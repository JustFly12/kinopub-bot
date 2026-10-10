import type { DeviceReport } from './devices.js';
import { isDeviceCode } from './device-code.js';
import { DeviceCheckError } from './errors.js';

export interface ActivationPlan {
  baselineDeviceIds: string[];
  preActivationRemovalIds: string[];
  postActivationRemovalIds: string[];
  removedDeviceIds: string[];
  activationSubmitted: boolean;
  activatedDeviceId?: string;
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

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid persisted activation plan field: ${field}.`);
  }
  return [...value];
}

export function restoreActivationPlan(value: unknown): ActivationPlan | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted activation plan.');
  const saved = value as Record<string, unknown>;
  if (typeof saved.activationSubmitted !== 'boolean') throw new Error('Invalid persisted activation plan submission state.');
  const baselineDeviceIds = stringArray(saved.baselineDeviceIds, 'baselineDeviceIds');
  const removedDeviceIds = stringArray(saved.removedDeviceIds, 'removedDeviceIds');
  const oldPlannedRemovalIds = 'plannedRemovalIds' in saved ? stringArray(saved.plannedRemovalIds, 'plannedRemovalIds') : undefined;
  const migratedPreRemovalIds = oldPlannedRemovalIds && !saved.activationSubmitted && baselineDeviceIds.length === 5 && removedDeviceIds.length === 0
    ? oldPlannedRemovalIds.slice(0, 1)
    : [];
  const plan: ActivationPlan = {
    baselineDeviceIds,
    preActivationRemovalIds: 'preActivationRemovalIds' in saved ? stringArray(saved.preActivationRemovalIds, 'preActivationRemovalIds') : migratedPreRemovalIds,
    postActivationRemovalIds: 'postActivationRemovalIds' in saved ? stringArray(saved.postActivationRemovalIds, 'postActivationRemovalIds') : [],
    removedDeviceIds,
    activationSubmitted: saved.activationSubmitted,
  };
  if (saved.activatedDeviceId !== undefined) {
    if (typeof saved.activatedDeviceId !== 'string') throw new Error('Invalid persisted activated device identifier.');
    plan.activatedDeviceId = saved.activatedDeviceId;
  }
  return plan;
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
      preActivationRemovalIds: report.count === report.limit ? report.devices.slice(0, 1).map(device => device.id) : [],
      postActivationRemovalIds: [],
      removedDeviceIds: [],
      activationSubmitted: false,
    };
    await saveState();
  }
  const plan = state.activationPlan;
  let reconciledPreviousActivation = Boolean(plan.activatedDeviceId);

  const removePlanned = async (ids: string[]): Promise<void> => {
    const currentIds = new Set(report.devices.map(device => device.id));
    for (const id of ids) {
      if (!currentIds.has(id) && !plan.removedDeviceIds.includes(id)) plan.removedDeviceIds.push(id);
    }
    await saveState();
    for (const id of ids) {
      if (plan.removedDeviceIds.includes(id)) continue;
      report = await session.removeDevice(id);
      if (report.devices.some(device => device.id === id)) {
        throw new DeviceCheckError('REMOVAL_UNCONFIRMED', `Device ${id} still appears after removal.`);
      }
      plan.removedDeviceIds.push(id);
      await saveState();
    }
  };

  const planPostActivationCleanup = async (newDeviceId: string): Promise<void> => {
    const excess = Math.max(0, report.count - 3);
    const candidates = report.devices.filter(device => device.id !== newDeviceId).slice(0, excess);
    if (candidates.length !== excess) {
      throw new DeviceCheckError('PAGE_CHANGED', 'Could not select enough old devices to restore the three-device limit.');
    }
    plan.activatedDeviceId = newDeviceId;
    plan.postActivationRemovalIds = candidates.map(device => device.id);
    await saveState();
  };

  if (plan.activatedDeviceId) {
    if (!report.devices.some(device => device.id === plan.activatedDeviceId)) {
      throw new DeviceCheckError('PAGE_CHANGED', 'The newly activated device disappeared before cleanup completed.');
    }
  } else if (plan.activationSubmitted) {
    const baseline = new Set(plan.baselineDeviceIds);
    const newDevices = report.devices.filter(device => !baseline.has(device.id));
    if (newDevices.length > 1) {
      throw new DeviceCheckError('PAGE_CHANGED', 'More than one new device appeared while recovering activation.');
    }
    if (newDevices.length === 1) {
      reconciledPreviousActivation = true;
      await planPostActivationCleanup(newDevices[0]!.id);
    } else {
      throw new DeviceCheckError('ACTIVATION_UNCONFIRMED', 'A previous activation is still unconfirmed. Retry later; the bot will not submit another code until it can reconcile the result.');
    }
  }

  if (!plan.activatedDeviceId) {
    await removePlanned(plan.preActivationRemovalIds);
    plan.activationSubmitted = true;
    await saveState();
    try {
      report = await session.activateDevice(code);
    } catch (error) {
      if (error instanceof DeviceCheckError && error.code === 'DEVICE_CODE_REJECTED') {
        delete state.activationPlan;
        await saveState();
      }
      throw error;
    }
    const baseline = new Set(plan.baselineDeviceIds);
    const newDevices = report.devices.filter(device => !baseline.has(device.id));
    if (newDevices.length !== 1) {
      throw new DeviceCheckError('ACTIVATION_UNCONFIRMED', 'Could not uniquely identify the newly activated device.');
    }
    await planPostActivationCleanup(newDevices[0]!.id);
  }

  await removePlanned(plan.postActivationRemovalIds);
  const removedDeviceIds = [...plan.removedDeviceIds];
  delete state.activationPlan;
  await saveState();
  return {report, removedDeviceIds, reconciledPreviousActivation};
}
