import assert from 'node:assert/strict';
import test from 'node:test';
import { BotService, type BotState, type WebsiteSession } from '../src/bot-service.js';
import { DeviceCheckError } from '../src/errors.js';
const report = {count:2,limit:5,browserSessions:3,devices:[],cleanupCandidates:[]};
function setup(expired = false) {
  let now = 1000;
  const calls = {inspect:0,login:0,code:0,close:0};
  const messages: string[] = [];
  const state: BotState = {ownerStarted:true,nextCheckAt:0,lastCheckAt:null,lastResult:'never',challengePending:false};
  const session: WebsiteSession = {
    async inspect() { calls.inspect++; if(expired) throw new DeviceCheckError('LOGIN_REQUIRED','Expired'); return report; },
    async login() { calls.login++; return {kind:'code'}; },
    async submitCode(code) { calls.code++; return code === '123456' ? {kind:'ready',report} : {kind:'code'}; },
    async removeDevice() { return report; },
    async activateDevice() { return report; },
    async close() { calls.close++; },
  };
  const service = new BotService({ownerId:42,createSession:()=>session,notifyOwner:async text=>{messages.push(text);},saveState:async next=>{Object.assign(state,next);},state,now:()=>now});
  return {service,state,calls,messages,advance:(ms:number)=>{now+=ms;}};
}
test('daily check is silent when authorized and does not run twice before due',async()=>{
 const s=setup(); await s.service.tick(); await s.service.tick();
 assert.equal(s.calls.inspect,1); assert.equal(s.calls.close,1); assert.deepEqual(s.messages,[]);
 assert.equal(s.state.lastResult,'authorized'); assert.equal(s.state.nextCheckAt,86401000);
});
test('no proactive checks before owner starts bot',async()=>{
 const s=setup(); s.state.ownerStarted=false; await s.service.tick(); assert.equal(s.calls.inspect,0);
});
test('expired session prompts owner once, retains challenge, and closes after verification',async()=>{
 const s=setup(true); await s.service.tick(); await s.service.check();
 assert.equal(s.calls.login,1); assert.equal(s.calls.close,0); assert.equal(s.messages.length,1);
 assert.match(s.messages[0]!, /\/code/); assert.equal(s.state.challengePending,true);
 await s.service.submitCode(99,'123456'); assert.equal(s.calls.code,0);
 await s.service.submitCode(42,'000000'); assert.equal(s.state.challengePending,true);
 await s.service.submitCode(42,'123456'); assert.equal(s.calls.close,1); assert.equal(s.state.challengePending,false);
 assert.equal(s.state.lastResult,'authorized');
});
test('expired email challenge closes browser without sending another email',async()=>{
 const s=setup(true); await s.service.tick(); s.advance(300001); await s.service.tick(); await s.service.tick();
 assert.equal(s.calls.login,1); assert.equal(s.calls.close,1); assert.equal(s.state.challengePending,false);
 const result=await s.service.submitCode(42,'123456'); assert.match(result,/No pending/); assert.equal(s.calls.code,0);
});
test('simultaneous checks share one account operation and a single challenge',async()=>{
 const s=setup(true); await Promise.all([s.service.check(),s.service.check()]);
 assert.equal(s.calls.inspect,1); assert.equal(s.calls.login,1); await s.service.close(); assert.equal(s.calls.close,1);
});
test('three rejected codes end the challenge',async()=>{
 const s=setup(true); await s.service.check();
 for(let i=0;i<3;i++) await s.service.submitCode(42,'000000');
 assert.equal(s.calls.close,1); assert.equal(s.state.challengePending,false);
});

test('device activation runs FIFO cleanup in the shared account queue and reports success',async()=>{
 const rows=['1','2','3','4'].map(id=>({id,name:`TV ${id}`,hardware:'TV',created:`Добавлен: 0${id} October 2026 в 10:00`,accessed:'Активность: 08 October 2026 в 11:00'}));
 let current=[...rows];const removed:string[]=[];const activated:string[]=[];
 const state: BotState={ownerStarted:true,nextCheckAt:0,lastCheckAt:null,lastResult:'never',challengePending:false};
 const session={
  async inspect(){return {count:current.length,limit:5,browserSessions:0,devices:current,cleanupCandidates:current.length>=4?current.slice(0,2):[]};},
  async login(){return {kind:'ready' as const,report};},async submitCode(){return {kind:'ready' as const,report};},
  async removeDevice(id:string){removed.push(id);current=current.filter(device=>device.id!==id);return this.inspect();},
  async activateDevice(code:string){activated.push(code);current.push({id:'9',name:'New TV',hardware:'TV',created:'Добавлен: 09 October 2026 в 10:00',accessed:'Активность: 09 October 2026 в 10:00'});return this.inspect();},
  async close(){},
 };
 const service=new BotService({ownerId:42,createSession:()=>session,notifyOwner:async()=>{},saveState:async next=>{Object.assign(state,next);},state,now:()=>1000});
 const message=await (service as unknown as {activateDevice(code:string):Promise<string>}).activateDevice('A1b2C');
 assert.deepEqual(removed,['1','2']);assert.deepEqual(activated,['A1b2C']);assert.match(message,/Device activated/);assert.equal(state.activationPlan,undefined);
});

test('device activation removes invisible Telegram formatting marks from the command argument',async()=>{
 const activated:string[]=[];
 const state:BotState={ownerStarted:true,nextCheckAt:0,lastCheckAt:null,lastResult:'never',challengePending:false};
 const session={
  async inspect(){return report;},async login(){return {kind:'ready' as const,report};},async submitCode(){return {kind:'ready' as const,report};},
  async removeDevice(){return report;},async activateDevice(code:string){activated.push(code);return {...report,count:3};},async close(){},
 };
 const service=new BotService({ownerId:42,state,createSession:()=>session,notifyOwner:async()=>{},saveState:async()=>{}});
 const message=await service.activateDevice('\u200B3CUU7\u200B');
 assert.deepEqual(activated,['3CUU7']);assert.match(message,/Device activated/);
});

test('device activation starts reauthorization instead of deleting when the session expired',async()=>{
 const s=setup(true);
 const message=await (s.service as unknown as {activateDevice(code:string):Promise<string>}).activateDevice('A1b2C');
 assert.equal(s.calls.login,1);assert.equal(s.calls.code,0);assert.equal(s.state.challengePending,true);assert.match(message,/Email verification/);
});
