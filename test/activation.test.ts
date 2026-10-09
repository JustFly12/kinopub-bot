import assert from 'node:assert/strict';
import test from 'node:test';
import { activateWithCleanup, type ActivationSession, type ActivationState } from '../src/activation.js';
import type { DeviceReport, DeviceRow } from '../src/devices.js';

function row(id: string): DeviceRow {
  return {id, name:`Device ${id}`, hardware:'TV', created:`Добавлен: 0${id} October 2026 в 10:00`, accessed:'Активность: 08 October 2026 в 11:00'};
}

function report(ids: string[]): DeviceReport {
  const devices=ids.map(row);
  return {count:ids.length,limit:5,browserSessions:4,devices,cleanupCandidates:ids.length>=4?devices.slice(0,2):[]};
}

function fakeSession(initialIds: string[], failRemovalId?: string) {
  let ids=[...initialIds];
  const calls={inspect:0,removed:[] as string[],activated:[] as string[]};
  const session: ActivationSession={
    async inspect(){calls.inspect++;return report(ids);},
    async removeDevice(id){
      if(failRemovalId===id) throw new Error('removal interrupted');
      calls.removed.push(id);ids=ids.filter(value=>value!==id);return report(ids);
    },
    async activateDevice(code){calls.activated.push(code);ids.push('9');return report(ids);},
  };
  return {session,calls,current:()=>[...ids]};
}

test('two or three app devices activate without deleting anything',async()=>{
 for(const ids of [['1','2'],['1','2','3']]) {
  const fake=fakeSession(ids);const state: ActivationState={};let saves=0;
  const result=await activateWithCleanup(fake.session,state,async()=>{saves++;},'A1b2C');
  assert.deepEqual(fake.calls.removed,[]);assert.deepEqual(fake.calls.activated,['A1b2C']);
  assert.equal(result.report.count,ids.length+1);assert.equal(state.activationPlan,undefined);assert.ok(saves>=2);
 }
});

test('four or five devices persist and remove the oldest two before activation',async()=>{
 for(const ids of [['1','2','3','4'],['1','2','3','4','5']]) {
  const fake=fakeSession(ids);const state: ActivationState={};const snapshots:string[]=[];
  await activateWithCleanup(fake.session,state,async()=>{snapshots.push(JSON.stringify(state));},'A1b2C');
  assert.deepEqual(fake.calls.removed,['1','2']);assert.deepEqual(fake.calls.activated,['A1b2C']);
  assert.match(snapshots[0]!,/plannedRemovalIds/);assert.equal(state.activationPlan,undefined);
 }
});

test('a retry resumes the saved removal plan instead of choosing a fresh pair',async()=>{
 const state: ActivationState={};const first=fakeSession(['1','2','3','4','5'],'2');
 await assert.rejects(activateWithCleanup(first.session,state,async()=>{},'A1b2C'),/removal interrupted/);
 assert.deepEqual(first.calls.removed,['1']);
 assert.deepEqual(state.activationPlan?.plannedRemovalIds,['1','2']);
 assert.deepEqual(state.activationPlan?.removedDeviceIds,['1']);
 const second=fakeSession(first.current());
 await activateWithCleanup(second.session,state,async()=>{},'Z9y8X');
 assert.deepEqual(second.calls.removed,['2']);assert.deepEqual(second.calls.activated,['Z9y8X']);
 assert.equal(state.activationPlan,undefined);
});

test('invalid device codes cannot inspect, delete, or activate',async()=>{
 for(const code of ['A1b2','A1b2C3','A1-b2','']) {
  const fake=fakeSession(['1','2','3','4']);const state: ActivationState={};
  await assert.rejects(activateWithCleanup(fake.session,state,async()=>{},code),error=>error instanceof Error&&'code'in error&&error.code==='INVALID_DEVICE_CODE');
  assert.equal(fake.calls.inspect,0);assert.deepEqual(fake.calls.removed,[]);assert.deepEqual(fake.calls.activated,[]);
 }
});

test('a retry reconciles an already-added device without submitting the new code',async()=>{
 const state: ActivationState={activationPlan:{baselineDeviceIds:['1','2'],plannedRemovalIds:[],removedDeviceIds:[],activationSubmitted:true}};
 const fake=fakeSession(['1','2','9']);
 const result=await activateWithCleanup(fake.session,state,async()=>{},'Z9y8X');
 assert.deepEqual(fake.calls.activated,[]);assert.equal(result.reconciledPreviousActivation,true);assert.equal(state.activationPlan,undefined);
});
