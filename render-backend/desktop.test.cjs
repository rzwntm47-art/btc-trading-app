'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDesktop,remoteOrigin}=require('./desktop.cjs');
const {DemoEngine}=require('../demo-execution/engine.js');
const TOKEN='test-local-token-0123456789012345678901234',KEY='A'.repeat(64),SECRET='s'.repeat(64),ORIGIN='https://test-laptop.testnet.ts.net';
class FakeEngine extends DemoEngine{
  constructor(...args){super(...args);FakeEngine.last=this;this.ticks=0;this.starts=0;this.closes=0;}
  async initialize(){this.connected=true;this.tradingReady=true;this.account={assets:[],positions:[]};this.accountAt=Date.now();}
  async start(){this.starts++;this.auto=true;}
  async tick(){if(!this.busy)this.ticks++;}
  async refresh(){}
  async reconcile(){}
  async updateIncome(){}
  async close(){this.closes++;}
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(fn){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-pair-test-'));let time=Date.now();
  const app=createDesktop({token:TOKEN,dataDir,Engine:FakeEngine,now:()=>time,intervalMs:15,fetcher:()=>{throw Error('No exchange calls allowed');}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  const request=async(route,data,{mobile=false,cookie='',auth=TOKEN,origin,headers={}}={})=>{
    const h={...headers};if(mobile){h['X-Forwarded-Host']=new URL(ORIGIN).host;if(cookie)h.Cookie=cookie;if(data!==undefined)h.Origin=origin??ORIGIN;}
    else{h.Authorization='Bearer '+auth;h.Origin=origin??'https://rzwntm47-art.github.io';}
    if(data!==undefined)h['Content-Type']='application/json';
    const response=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:h,body:data===undefined?undefined:JSON.stringify(data)});
    const text=await response.text();let json;try{json=JSON.parse(text);}catch{}return {status:response.status,json,text,headers:response.headers};
  };
  const connect=async(state=null)=>{const result=await request('/host/connect',{requestId:'connect-test-0123456789',key:KEY,secret:SECRET,state,demoOnly:true});assert.equal(result.status,202);for(let i=0;i<100&&app.snapshot().connecting;i++)await delay(2);assert.equal(app.snapshot().engine.connected,true);};
  const pair=async()=>{const generated=await request('/host/pair',{origin:ORIGIN});assert.equal(generated.status,200);const code=new URLSearchParams(new URL(generated.json.url).hash.slice(1)).get('pair');const paired=await request('/mobile/pair',{code},{mobile:true});assert.equal(paired.status,200,JSON.stringify(paired.json));return {generated,code,csrf:paired.json.csrf,cookie:paired.headers.get('set-cookie').split(';')[0],headers:paired.headers};};
  try{await fn({app,request,connect,pair,dataDir,advance:ms=>time+=ms});}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});}
}
test('private HTTPS address validation rejects public, credential-bearing and non-HTTPS destinations',()=>{
  assert.equal(remoteOrigin(ORIGIN),ORIGIN);
  for(const v of ['http://test-laptop.testnet.ts.net','https://evil.example','https://user:pass@test-laptop.testnet.ts.net','https://test-laptop.testnet.ts.net/path','https://test-laptop.testnet.ts.net:8443'])assert.throws(()=>remoteOrigin(v));
});
test('background connection is single-owner, imports journal, stays stopped and persists no credentials',()=>fixture(async({app,request,connect,dataDir})=>{
  await connect({version:1,records:[],startedAt:123,goal:false});assert.equal(app.snapshot().engine.auto,false);
  const publicState=JSON.stringify((await request('/host/status')).json);assert.ok(!publicState.includes(SECRET));assert.ok(!publicState.includes(KEY));assert.ok(!publicState.includes(TOKEN));
  const files=fs.readdirSync(dataDir);assert.equal(files.length,1);const journal=fs.readFileSync(path.join(dataDir,files[0]),'utf8');assert.equal(JSON.parse(journal).startedAt,123);assert.ok(!journal.includes(SECRET));assert.ok(!journal.includes(KEY));
  assert.equal((await request('/host/connect',{requestId:'different-request-id',key:KEY,secret:SECRET,demoOnly:true})).status,400);
  assert.equal((await request('/relay',{method:'GET'})).status,409);
  const count=FakeEngine.last.ticks;await delay(50);assert.ok(FakeEngine.last.ticks>count);
}));
test('QR is single-use, expires, and contains only a private URL plus random pairing code',()=>fixture(async({request,connect,pair,advance})=>{
  await connect();const p=await pair();assert.match(p.generated.json.svg,/<svg/);assert.ok(p.code.length>=40);
  assert.ok(!JSON.stringify(p.generated.json).includes(SECRET));assert.ok(!JSON.stringify(p.generated.json).includes(TOKEN));
  const cookie=p.headers.get('set-cookie');for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));
  assert.equal((await request('/mobile/pair',{code:p.code},{mobile:true})).status,401);
  const q=await request('/host/pair',{origin:ORIGIN});const code=new URLSearchParams(new URL(q.json.url).hash.slice(1)).get('pair');advance(120001);
  assert.equal((await request('/mobile/pair',{code},{mobile:true})).status,401);
}));
test('phone authentication, CSRF, origin and laptop-only endpoint restrictions are enforced',()=>fixture(async({request,connect,pair})=>{
  await connect();const p=await pair();
  assert.equal((await request('/mobile/status',undefined,{mobile:true})).status,401);
  assert.equal((await request('/mobile/status',undefined,{mobile:true,cookie:p.cookie})).status,200);
  assert.equal((await request('/mobile/command',{id:'start-test-0123456789',action:'start'},{mobile:true,cookie:p.cookie})).status,403);
  assert.equal((await request('/mobile/command',{id:'start-test-0123456789',action:'start',csrf:p.csrf},{mobile:true,cookie:p.cookie,origin:'https://evil.example'})).status,403);
  assert.equal((await request('/host/connect',{key:KEY,secret:SECRET},{mobile:true,cookie:p.cookie,origin:ORIGIN})).status,403);
  assert.equal((await request('/host/status',undefined,{headers:{'X-Forwarded-For':'100.0.0.1'}})).status,403);
  assert.equal((await request('/host/status',undefined,{auth:'wrong'})).status,401);
  for(const action of ['withdraw','reset','disconnect'])assert.ok((await request('/mobile/command',{id:'forbidden-0123456789',action,csrf:p.csrf},{mobile:true,cookie:p.cookie})).status>=400);
  await request('/host/revoke',{});assert.equal((await request('/mobile/status',undefined,{mobile:true,cookie:p.cookie})).status,401);
}));
test('commands execute once per ID, Stop cancels queued Start, and revocation does not stop trading',()=>fixture(async({app,request,connect,pair})=>{
  await connect();const p=await pair();const options={mobile:true,cookie:p.cookie};
  const start={id:'start-one-0123456789',action:'start',csrf:p.csrf};
  await request('/mobile/command',start,options);await delay(10);await request('/mobile/command',start,options);assert.equal(FakeEngine.last.starts,1);assert.equal(app.snapshot().engine.auto,true);
  await request('/host/revoke',{});assert.equal(app.snapshot().engine.auto,true);
  await request('/host/command',{id:'stop-one-0123456789',action:'stop'});
  FakeEngine.last.busy=true;
  await request('/host/command',{id:'start-queued-012345',action:'start'});
  await request('/host/command',{id:'stop-queued-0123456',action:'stop'});FakeEngine.last.busy=false;await delay(70);
  assert.equal(FakeEngine.last.starts,1);assert.equal(app.snapshot().engine.auto,false);
  const entry=await request('/host/command?id=start-queued-012345');assert.equal(entry.json.status,'error');
}));
test('only owned positions can close and repeated close IDs do not repeat the action',()=>fixture(async({request,connect,pair})=>{
  await connect();const p=await pair(),options={mobile:true,cookie:p.cookie};
  await request('/mobile/command',{id:'close-unknown-0123456',action:'close',symbol:'BTCUSDT',csrf:p.csrf},options);await delay(10);assert.equal(FakeEngine.last.closes,0);
  FakeEngine.last.state.records.push({id:'bd1_test',symbol:'BTCUSDT',side:'BUY'});
  const action={id:'close-known-012345678',action:'close',symbol:'BTCUSDT',csrf:p.csrf};await request('/mobile/command',action,options);await delay(10);await request('/mobile/command',action,options);assert.equal(FakeEngine.last.closes,1);
}));
test('mobile page is the generated app with same-origin policy and no referrer',()=>fixture(async({request,connect,pair})=>{
  await connect();await pair();const page=await request('/mobile',undefined,{mobile:true});assert.equal(page.status,200);assert.match(page.text,/Pair Mobile/);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
}));

test('laptop status reports actual engine version and active entry sizing to mobile',()=>fixture(async({app,request,connect})=>{
 await connect();const state=(await request('/host/status')).json.engine;
 assert.equal(state.appVersion,'1.49');assert.deepEqual(state.entryPolicy,{margin:300,maxLeverage:10,strategy:'movers-momentum-v1'});
}));
