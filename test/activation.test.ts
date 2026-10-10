import assert from 'node:assert/strict';
import test from 'node:test';
import { activateWithCleanup, restoreActivationPlan, type ActivationSession, type ActivationState } from '../src/activation.js';
import type { DeviceReport, DeviceRow } from '../src/devices.js';

function row(id: string): DeviceRow {
  return {id, name:`Device ${id}`, hardware:'TV', created:`Добавлен: 0${id} October 2026 в 10:00`, accessed:'Активность: 08 October 2026 в 11:00'};
}

function report(ids: string[]): DeviceReport {
  const devices=ids.map(row);
  return {count:ids.length,limit:5,browserSessions:4,devices,cleanupCandidates:devices.slice(0,Math.max(0,ids.length-2))};
}

function fakeSession(initialIds: string[], failRemovalId?: string) {
  let ids=[...initialIds];
  const calls={inspect:0,removed:[] as string[],activated:[] as string[],events:[] as string[]};
  const session: ActivationSession={
    async inspect(){calls.inspect++;return report(ids);},
    async removeDevice(id){
      if(failRemovalId===id) throw new Error('removal interrupted');
      calls.removed.push(id);calls.events.push(`remove:${id}`);ids=ids.filter(value=>value!==id);return report(ids);
    },
    async activateDevice(code){calls.activated.push(code);calls.events.push(`activate:${code}`);ids.push('9');return report(ids);},
  };
  return {session,calls,current:()=>[...ids]};
}

test('two app devices activate without cleanup and finish at three',async()=>{
 const fake=fakeSession(['1','2']);const state: ActivationState={};let saves=0;
 const result=await activateWithCleanup(fake.session,state,async()=>{saves++;},'A1b2C');
 assert.deepEqual(fake.calls.removed,[]);assert.deepEqual(fake.calls.activated,['A1b2C']);
 assert.equal(result.report.count,3);assert.equal(state.activationPlan,undefined);assert.ok(saves>=2);
});

test('three or four devices activate first, then remove the oldest excess devices',async()=>{
 for(const [ids,removed] of [[['1','2','3'],['1']],[['1','2','3','4'],['1','2']]] as const) {
  const fake=fakeSession([...ids]);const state: ActivationState={};const snapshots:string[]=[];
  await activateWithCleanup(fake.session,state,async()=>{snapshots.push(JSON.stringify(state));},'A1b2C');
  assert.deepEqual(fake.calls.removed,removed);assert.deepEqual(fake.calls.events,[`activate:A1b2C`,...removed.map(id=>`remove:${id}`)]);
  assert.equal(fake.current().length,3);assert.match(snapshots.at(-2)!,/postActivationRemovalIds/);assert.equal(state.activationPlan,undefined);
 }
});

test('five devices remove one before activation and two afterward',async()=>{
 const fake=fakeSession(['1','2','3','4','5']);const state:ActivationState={};
 await activateWithCleanup(fake.session,state,async()=>{},'A1b2C');
 assert.deepEqual(fake.calls.events,['remove:1','activate:A1b2C','remove:2','remove:3']);
 assert.deepEqual(fake.current(),['4','5','9']);
});

test('a retry resumes post-activation cleanup without submitting a new code',async()=>{
 const state: ActivationState={};const first=fakeSession(['1','2','3','4'],'2');
 await assert.rejects(activateWithCleanup(first.session,state,async()=>{},'A1b2C'),/removal interrupted/);
 assert.deepEqual(first.calls.events,['activate:A1b2C','remove:1']);
 assert.deepEqual(state.activationPlan?.postActivationRemovalIds,['1','2']);
 assert.deepEqual(state.activationPlan?.removedDeviceIds,['1']);
 const second=fakeSession(first.current());
 const result=await activateWithCleanup(second.session,state,async()=>{},'Z9y8X');
 assert.deepEqual(second.calls.removed,['2']);assert.deepEqual(second.calls.activated,[]);
 assert.equal(result.reconciledPreviousActivation,true);assert.equal(state.activationPlan,undefined);
});

test('invalid device codes cannot inspect, delete, or activate',async()=>{
 for(const code of ['A1b2','A1b2C3','A1-b2','']) {
  const fake=fakeSession(['1','2','3','4']);const state: ActivationState={};
  await assert.rejects(activateWithCleanup(fake.session,state,async()=>{},code),error=>error instanceof Error&&'code'in error&&error.code==='INVALID_DEVICE_CODE');
  assert.equal(fake.calls.inspect,0);assert.deepEqual(fake.calls.removed,[]);assert.deepEqual(fake.calls.activated,[]);
 }
});

test('a retry reconciles an already-added device without submitting the new code',async()=>{
 const state: ActivationState={activationPlan:{baselineDeviceIds:['1','2','3'],preActivationRemovalIds:[],postActivationRemovalIds:[],removedDeviceIds:[],activationSubmitted:true}};
 const fake=fakeSession(['1','2','3','9']);
 const result=await activateWithCleanup(fake.session,state,async()=>{},'Z9y8X');
 assert.deepEqual(fake.calls.activated,[]);assert.deepEqual(fake.calls.removed,['1']);assert.equal(result.report.count,3);
 assert.equal(result.reconciledPreviousActivation,true);assert.equal(state.activationPlan,undefined);
});

test('an uncertain submitted activation never submits another code automatically',async()=>{
 const state: ActivationState={activationPlan:{baselineDeviceIds:['1','2','3'],preActivationRemovalIds:[],postActivationRemovalIds:[],removedDeviceIds:[],activationSubmitted:true}};
 const fake=fakeSession(['1','2','3']);
 await assert.rejects(activateWithCleanup(fake.session,state,async()=>{},'Z9y8X'),error=>error instanceof Error&&'code'in error&&error.code==='ACTIVATION_UNCONFIRMED');
 assert.deepEqual(fake.calls.activated,[]);assert.equal(state.activationPlan?.activationSubmitted,true);
});

test('old persisted activation plans migrate without carrying obsolete pre-removals forward',()=>{
 const plan=restoreActivationPlan({baselineDeviceIds:['1','2','3','4'],plannedRemovalIds:['1','2'],removedDeviceIds:['1'],activationSubmitted:false});
 assert.deepEqual(plan,{baselineDeviceIds:['1','2','3','4'],preActivationRemovalIds:[],postActivationRemovalIds:[],removedDeviceIds:['1'],activationSubmitted:false});
});

test('an old untouched five-device plan migrates one pre-removal to create capacity',()=>{
 const plan=restoreActivationPlan({baselineDeviceIds:['1','2','3','4','5'],plannedRemovalIds:['1','2'],removedDeviceIds:[],activationSubmitted:false});
 assert.deepEqual(plan?.preActivationRemovalIds,['1']);
});
