import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium,type Browser,type Page} from 'playwright';
import {activateDeviceFromPage,removeDeviceFromPage} from '../src/device-actions.js';

let browser: Browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
const origin='https://kino.watch';

function deviceHtml(ids:string[],counter=ids.length):string {
 const cards=ids.map((id,index)=>`<div class="device" data-id="${id}"><div class="title">TV ${id}</div><div class="hardware">TV</div><div class="created">Добавлен: 0${index+1} October 2026 в 10:00</div><div class="accessed">Активность: 08 October 2026 в 11:00</div></div>`).join('');
 return `<form id="add-device"><input maxlength="5"><button type="submit">Добавить</button><div class="errors"></div></form><div class="device-counter">Устройства (<span>${counter}</span>/5)</div><div class="devices"><div class="device template"></div>${cards}</div><div class="browsers"><div class="device is_browser" data-id="800"></div></div>`;
}

async function fixture(page:Page,initialIds:string[],options:{rejectCode?:boolean;rejectCodeWithHtml?:boolean;confirmRemoval?:boolean;confirmActivation?:boolean;staleActivationReloads?:number}={}) {
 let ids=[...initialIds];let activationSeen=false;let staleReloads=options.staleActivationReloads??0;const requests:{path:string;data:URLSearchParams;csrf:string|undefined}[]=[];
 await page.route('**/*',async route=>{
  const request=route.request();const url=new URL(request.url());const data=new URLSearchParams(request.postData()??'');requests.push({path:url.pathname,data,csrf:request.headers()['x-csrf-token']});
  if(url.pathname==='/device/remove') {if(options.confirmRemoval!==false) ids=ids.filter(id=>id!==data.get('id'));await route.fulfill({contentType:'application/json',body:JSON.stringify({status:200})});return;}
  if(url.pathname==='/device/activate') {activationSeen=true;if(options.rejectCodeWithHtml){await route.fulfill({status:400,contentType:'text/html',body:'Bad Request'});return;}await route.fulfill({contentType:'application/json',body:JSON.stringify(options.rejectCode?{status:400,error:true,message:'Invalid code'}:{status:200})});return;}
  if(url.pathname==='/device/wait-by-code') {if(options.confirmActivation!==false&&!options.rejectCode&&!ids.includes('9')) ids.push('9');await route.fulfill({contentType:'application/json',body:JSON.stringify(options.confirmActivation===false?{status:404}:{status:200,device:{id:'9'}})});return;}
  if(url.pathname==='/device') {const stale=activationSeen&&staleReloads-->0;await route.fulfill({contentType:'text/html; charset=utf-8',body:deviceHtml(ids,stale?ids.length-1:ids.length)});return;}
  await route.abort();
 });
 await page.goto(origin+'/device');
 await page.evaluate("window.yii = {getCsrfToken: function () { return 'test-csrf-token'; }}");
 return {requests,current:()=>[...ids]};
}

test('removal posts the selected ID and verifies it disappeared from the app list',async()=>{
 const page=await browser.newPage();try {const f=await fixture(page,['1','2','3','4']);const report=await removeDeviceFromPage(page,origin,'1');
  const request=f.requests.find(item=>item.path==='/device/remove');assert.equal(request?.data.get('id'),'1');assert.deepEqual(f.current(),['2','3','4']);assert.equal(report.count,3);
 } finally {await page.close();}
});

test('removal refuses a success response when the device still exists',async()=>{
 const page=await browser.newPage();try {await fixture(page,['1','2','3','4'],{confirmRemoval:false});
  await assert.rejects(removeDeviceFromPage(page,origin,'1'),error=>error instanceof Error&&'code'in error&&error.code==='REMOVAL_UNCONFIRMED');
 } finally {await page.close();}
});

test('activation submits the five-character alphanumeric code and verifies the new app registration',async()=>{
 const page=await browser.newPage();try {const f=await fixture(page,['1','2']);assert.equal(await page.evaluate(()=>(window as typeof window&{yii?:{getCsrfToken?:()=>string}}).yii?.getCsrfToken?.()),'test-csrf-token');const report=await activateDeviceFromPage(page,origin,'A1b2C',{attempts:2,intervalMs:1});
  const request=f.requests.find(item=>item.path==='/device/activate');assert.equal(request?.data.get('code'),'A1b2C');assert.equal(request?.csrf,'test-csrf-token');assert.deepEqual(f.current(),['1','2','9']);assert.equal(report.count,3);
 } finally {await page.close();}
});

test('activation retries a transient stale device counter during verification',async()=>{
 const page=await browser.newPage();try {await fixture(page,['1','2'],{staleActivationReloads:1});
  const report=await activateDeviceFromPage(page,origin,'3CUU7',{attempts:2,intervalMs:1});assert.equal(report.count,3);
 } finally {await page.close();}
});

test('activation reports rejected and unconfirmed codes without claiming success',async()=>{
 for(const options of [{rejectCode:true},{rejectCodeWithHtml:true},{confirmActivation:false}]) {const page=await browser.newPage();try {await fixture(page,['1','2'],options);
  await assert.rejects(activateDeviceFromPage(page,origin,'A1b2C',{attempts:2,intervalMs:1}),error=>error instanceof Error&&'code'in error&&['DEVICE_CODE_REJECTED','ACTIVATION_UNCONFIRMED'].includes(String(error.code)));
 } finally {await page.close();}}
});
