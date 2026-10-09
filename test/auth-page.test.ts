import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import {chromium, type Browser} from 'playwright';
import {loginPage,submitEmailCode} from '../src/auth-page.js';
let browser: Browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
const origin='https://kino.watch';
const challenge='<form method="post" action="/email-confirm"><p>Enter code from your email</p><input name="confirmation[code]" autocomplete="one-time-code"><button type="submit">Confirm</button></form>';
const device='<a href="/user/logout">Logout</a><form id="add-device"></form><div class="device-counter">Устройства (<span>0</span>/5)</div><div class="devices"></div>';
test('login preserves site form submission and email challenge can be completed without mailbox access',async()=>{
 const page=await browser.newPage(); let signedIn=false; let sawCredentials=false;
 try {
  await page.route('**/*',async route=>{
   const request=route.request(); const path=new URL(request.url()).pathname;
   let body='';
   if(path==='/user/login' && request.method()==='GET') body='<form id="login-form" method="post" action="/user/login"><input type="hidden" name="_csrf" value="fixture-token"><input id="login-form-login" name="user"><input id="login-form-password" name="password" type="password"><button type="submit">Войти</button></form>';
   else if(path==='/user/login') {const data=new URLSearchParams(request.postData()??''); sawCredentials=data.get('user')==='fixture-user'&&data.get('password')==='fixture-password'&&data.get('_csrf')==='fixture-token'; body=challenge;}
   else if(path==='/email-confirm') {signedIn=new URLSearchParams(request.postData()??'').get('confirmation[code]')==='123456';body=signedIn?device:challenge;}
   else if(path==='/device') body=signedIn?device:challenge;
   await route.fulfill({contentType:'text/html',body});
  });
  assert.deepEqual(await loginPage(page,origin,'fixture-user','fixture-password'),{kind:'code'});
  assert.equal(sawCredentials,true);
  assert.deepEqual(await submitEmailCode(page,origin,'000000'),{kind:'code'});
  const result=await submitEmailCode(page,origin,'123456');
  assert.equal(result.kind,'ready');
  if(result.kind==='ready') assert.equal(result.report.count,0);
 } finally {await page.close();}
});
test('unknown challenge and cross-origin forms are refused before entering a code',async()=>{
 for(const html of ['<form><input name="unknown"><button>Send</button></form>', '<form action="https://example.org/collect"><p>Email code</p><input name="code"><button>Confirm</button></form>']) {
  const page=await browser.newPage();
  try {await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto(origin+'/email-confirm');
   await assert.rejects(submitEmailCode(page,origin,'123456'),error=>error instanceof Error && 'code' in error && ['AUTH_CHALLENGE_UNSUPPORTED','UNEXPECTED_REDIRECT'].includes(String(error.code)));
   assert.equal(await page.locator('input').inputValue(),'');
  } finally {await page.close();}
 }
});
