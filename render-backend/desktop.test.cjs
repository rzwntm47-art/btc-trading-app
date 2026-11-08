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
async function until(fn){for(let i=0;i<150&&!fn();i++)await delay(2);assert.ok(fn(),'condition did not become true');}
async function fixture(fn,options={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-pair-test-'));let time=Date.now();
  const create=()=>createDesktop({token:TOKEN,dataDir,Engine:FakeEngine,now:()=>time,intervalMs:15,fetcher:()=>{throw Error('No exchange calls allowed');},...options});
  let app=create();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+app.server.address().port;
  const restart=async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app=create();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;return app;};
  const request=async(route,data,{mobile=false,cookie='',auth=TOKEN,origin,headers={}}={})=>{
    const h={...headers};if(mobile){h['X-Forwarded-Host']=new URL(ORIGIN).host;if(cookie)h.Cookie=cookie;if(data!==undefined)h.Origin=origin??ORIGIN;}
    else{h.Authorization='Bearer '+auth;h.Origin=origin??'https://rzwntm47-art.github.io';}
    if(data!==undefined)h['Content-Type']='application/json';
    const response=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:h,body:data===undefined?undefined:JSON.stringify(data)});
    const text=await response.text();let json;try{json=JSON.parse(text);}catch{}return {status:response.status,json,text,headers:response.headers};
  };
  const connect=async(state=null,key=KEY)=>{const result=await request('/host/connect',{requestId:'connect-test-0123456789',key,secret:SECRET,state,demoOnly:true});assert.equal(result.status,202);for(let i=0;i<100&&app.snapshot().connecting;i++)await delay(2);assert.equal(app.snapshot().engine.connected,true);};
  const pair=async()=>{const generated=await request('/host/pair',{origin:ORIGIN});assert.equal(generated.status,200);const code=new URLSearchParams(new URL(generated.json.url).hash.slice(1)).get('pair');const paired=await request('/mobile/pair',{code},{mobile:true});assert.equal(paired.status,200,JSON.stringify(paired.json));return {generated,code,csrf:paired.json.csrf,cookie:paired.headers.get('set-cookie').split(';')[0],headers:paired.headers};};
  try{await fn({app,request,connect,pair,dataDir,restart,advance:ms=>time+=ms});}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});}
}
test('private HTTPS address validation rejects public, credential-bearing and non-HTTPS destinations',()=>{
  assert.equal(remoteOrigin(ORIGIN),ORIGIN);
  for(const v of ['http://test-laptop.testnet.ts.net','https://evil.example','https://user:pass@test-laptop.testnet.ts.net','https://test-laptop.testnet.ts.net/path','https://test-laptop.testnet.ts.net:8443'])assert.throws(()=>remoteOrigin(v));
});
test('connector identifies its loaded version before Binance is connected',()=>fixture(async({request})=>{
 const state=(await request('/host/status')).json;assert.equal(state.service,'btc-demo-laptop');assert.equal(state.connectorVersion,require('../demo-execution/engine.js').APP_VERSION);assert.equal(state.restartSupported,true);assert.equal(state.restarting,false);assert.equal(state.engine,null);
}));
test('restart requires local authentication and matching generation; phone routes cannot restart',()=>fixture(async({app,request,connect,pair})=>{
 await connect();const p=await pair(),generation=app.snapshot().generation;
 assert.equal((await request('/host/restart',{generation},{auth:'wrong'})).status,401);
 assert.equal((await request('/host/restart',{generation},{headers:{'X-Forwarded-Host':new URL(ORIGIN).host}})).status,403);
 assert.equal((await request('/host/restart',{generation},{origin:'https://other.example'})).status,403);
 assert.equal((await request('/mobile/restart',{generation,csrf:p.csrf},{mobile:true,cookie:p.cookie})).status,404);
 assert.equal((await request('/host/restart',{generation:'stale'})).status,409);assert.equal(app.snapshot().restarting,false);assert.ok(app.server.listening);
}));
test('restart drains in-flight work, stops new commands, and preserves the journal and remembered phone',()=>fixture(async({app,request,connect,pair,dataDir,restart})=>{
 await connect();const p=await pair(),e=FakeEngine.last;e.auto=true;e.busy=true;
 const trust=fs.readFileSync(path.join(dataDir,'trusted-phones.json'),'utf8'),closed=new Promise(r=>app.server.once('close',r));
 const pending=request('/host/restart',{generation:app.snapshot().generation});await until(()=>app.snapshot().restarting);
 assert.equal(e.auto,false);assert.ok(app.server.listening);const ticks=e.ticks;await delay(30);assert.equal(e.ticks,ticks);
 assert.equal((await request('/host/command',{id:'restart-start-01234567',action:'start'})).status,409);
 assert.equal((await request('/host/connect',{requestId:'restart-connect-01234567',key:KEY,secret:SECRET,demoOnly:true})).status,409);
 assert.equal((await request('/host/restart',{generation:app.snapshot().generation})).status,409);
 e.state.goal=true;e.state.goalStopAt=12345;e.state.goalNet=21;e.busy=false;
 assert.equal((await pending).status,202);await closed;assert.equal(e.api.key,'');assert.equal(e.starts,0);
 assert.equal(fs.readFileSync(path.join(dataDir,'trusted-phones.json'),'utf8'),trust);
 const journal=JSON.parse(fs.readFileSync(path.join(dataDir,fs.readdirSync(dataDir).find(x=>x.startsWith('journal-'))),'utf8'));assert.equal(journal.goalStopAt,12345);assert.equal(journal.goalNet,21);
 await restart();assert.equal((await request('/mobile/status',undefined,{mobile:true,cookie:p.cookie})).status,200);
 await connect();assert.equal(FakeEngine.last.state.goalStopAt,12345);assert.equal(FakeEngine.last.auto,false);assert.equal(FakeEngine.last.starts,0);
}));
test('busy restart timeout leaves the connector open, Auto stopped, and position checks available',()=>fixture(async({app,request,connect})=>{
 await connect();const e=FakeEngine.last;e.auto=true;e.busy=true;
 const failed=await request('/host/restart',{generation:app.snapshot().generation});assert.equal(failed.status,409);assert.match(failed.json.error,/action is still pending/);assert.ok(app.server.listening);assert.equal(app.snapshot().restarting,false);assert.equal(e.auto,false);assert.ok(e.api.key);
 e.busy=false;const ticks=e.ticks;await until(()=>e.ticks>ticks);assert.equal((await request('/host/status')).status,200);
},{restartTimeoutMs:35}));
test('journal write failure cancels shutdown and keeps the existing connector available',()=>fixture(async({app,request,connect})=>{
 await connect();const e=FakeEngine.last;e.auto=true;e.save=()=>{throw Error('disk unavailable');};
 const result=await request('/host/restart',{generation:app.snapshot().generation});assert.equal(result.status,409);assert.match(result.json.error,/disk unavailable/);assert.ok(app.server.listening);assert.equal(app.snapshot().restarting,false);assert.equal(e.auto,false);assert.ok(e.api.key);
}));
test('restart waits for an accepted browser relay request before closing the listener',async()=>{
 let release,entered=false;const upstream=new Promise(r=>release=r);
 await fixture(async({app,request})=>{
  const input={method:'POST',path:'/fapi/v1/order',apiKey:KEY,query:'timestamp='+Date.now()+'&recvWindow=5000&signature='+'a'.repeat(64)};
  const relay=request('/relay',input);await until(()=>entered);assert.equal(app.server.pendingRelays(),1);
  const closed=new Promise(r=>app.server.once('close',r)),pending=request('/host/restart',{generation:app.snapshot().generation});await until(()=>app.snapshot().restarting);assert.ok(app.server.listening);
  assert.equal((await request('/relay',input)).status,409);release(Response.json({orderId:123,status:'FILLED'}));assert.equal((await relay).status,200);assert.equal((await pending).status,202);await closed;assert.equal(app.server.pendingRelays(),0);
 },{fetcher:async()=>{entered=true;return upstream;}});
});
test('launcher can drain an authenticated real connector and observe its released port',()=>fixture(async({app})=>{
 const {prepareRestart}=require('./launch-desktop.cjs'),base='http://127.0.0.1:'+app.server.address().port;
 const closed=new Promise(r=>app.server.once('close',r));await prepareRestart({base,token:TOKEN,log(){}});await closed;assert.equal(app.server.listening,false);
}));
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
 assert.equal(state.appVersion,'1.72');assert.deepEqual(state.entryPolicy,{margin:300,marginMode:'fixed',leverageMode:'highest-fee-compatible',maxLeverage:150,maxCommissionShare:.25,maxCommissionLossShare:.5,minimumNetAtTarget:5,strategy:'bollinger-wr-multiframe',entryDirection:'closed-1m-and-live-quotes',timeframes:[1,2,3,4,5,6,7,8,9,10,15,20,30,60],lossLimit:6,maxLossLimit:12,earlyLossExit:'confirmed-adverse-move',earlyLossMin:2,profitStart:5,profitStep:3,takeProfit:null,profitExit:'stepped-net-trailing',lossReduction:0,sessionTarget:20,sessionExit:'close-bot-positions',bollingerPeriod:20,bollingerDeviations:2,williamsPeriod:14});
}));

test('legacy phone trial commands are idempotent when legacy strategy is explicitly selected',()=>fixture(async({app,request,connect,pair,dataDir})=>{
 await connect();FakeEngine.last.bandRules=false;const p=await pair(),options={mobile:true,cookie:p.cookie},start={id:'trial-start-0123456789',action:'startTrial',csrf:p.csrf};
 await request('/mobile/command',start,options);await delay(15);const t={...app.snapshot().engine.state.oneHourTrial};assert.equal(t.until-t.startedAt,3600000);
 await request('/mobile/command',start,options);await delay(5);assert.equal(app.snapshot().engine.state.oneHourTrial.until,t.until);
 const file=fs.readdirSync(dataDir).find(x=>x.startsWith('journal-'));assert.ok(file);assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,file))).oneHourTrial.until,t.until);
 await request('/mobile/command',{id:'trial-end-0123456789',action:'endTrial',csrf:p.csrf},options);await delay(10);assert.ok(app.snapshot().engine.state.oneHourTrial.endedAt);assert.equal(app.snapshot().engine.auto,true);
 FakeEngine.last.busy=true;await request('/host/command',{id:'trial-queue-0123456789',action:'startTrial'});await request('/host/command',{id:'trial-stop-0123456789',action:'stop'});FakeEngine.last.busy=false;await delay(70);assert.equal(app.snapshot().engine.auto,false);assert.equal(app.snapshot().engine.state.oneHourTrial.until,t.until);
}));
test('current laptop engine rejects obsolete experiment activation and keeps stopped intent',()=>fixture(async({app,request,connect})=>{
 await connect();assert.equal(app.snapshot().engine.bandRules,true);
 await request('/host/command',{id:'obsolete-trial-0123456789',action:'startTrial'});await delay(15);
 const result=await request('/host/command?id=obsolete-trial-0123456789');assert.equal(result.json.status,'error');assert.match(result.json.error,/replaced/);assert.equal(app.snapshot().engine.auto,false);assert.equal(FakeEngine.last.starts,0);
}));

test('temporary remote Sync read failure preserves Auto and remote Stop cancels retries',()=>fixture(async({app,request,connect})=>{
 await connect();const e=FakeEngine.last;e.auto=true;e.refresh=async()=>{throw Object.assign(new Error('temporary read'),{code:503,requestMethod:'GET',requestPath:'/fapi/v3/account',uncertain:false});};
 const result=await request('/host/command',{id:'sync-error-recovery-12345',action:'refresh'});assert.equal(result.status,202);
 for(let i=0;i<50&&e.controlPending;i++)await delay(2);assert.equal(e.auto,true);assert.ok(e.retryAt>Date.now());
 await request('/host/command',{id:'stop-after-sync-error-123',action:'stop'});assert.equal(e.auto,false);assert.equal(e.retryAt,0);
}));

test('non-transient remote command errors hold entries without cancelling running Auto',()=>fixture(async({app,request,connect})=>{
 await connect();const e=FakeEngine.last;e.auto=true;e.refresh=async()=>{throw Error('Order status still settling');};
 await request('/host/command',{id:'sync-reconcile-hold-12345',action:'refresh'});
 for(let i=0;i<50&&e.controlPending;i++)await delay(2);
 const state=(await request('/host/status')).json.engine;assert.equal(state.auto,true);assert.match(state.entryHold,/Order status still settling/);assert.ok(state.retryAt>Date.now());
 await request('/host/command',{id:'stop-reconcile-hold-12345',action:'stop'});assert.equal(app.snapshot().engine.auto,false);assert.equal(app.snapshot().engine.entryHold,'');
}));

test('remembered phone survives restart, needs no repeated pairing, and sees the same engine snapshot',()=>fixture(async({request,connect,pair,restart,dataDir})=>{
 await connect();const p=await pair(),options={mobile:true,cookie:p.cookie};
 const saved=fs.readFileSync(path.join(dataDir,'trusted-phones.json'),'utf8');for(const secret of [KEY,SECRET,TOKEN,p.cookie.split('=')[1],p.code])assert.ok(!saved.includes(secret));
 const app=await restart();let phone=(await request('/mobile/status',undefined,options));assert.equal(phone.status,200);assert.equal(phone.json.engine,null);assert.equal(phone.json.pairedDevices,1);
 await connect();FakeEngine.last.auto=true;FakeEngine.last.entryHold='Order settling';FakeEngine.last.scanned=[{symbol:'BTCUSDT',phase:'Entry skipped',reason:'Fee check'}];
 phone=(await request('/mobile/status',undefined,options));const laptop=(await request('/host/status')).json;assert.deepEqual(phone.json.engine,laptop.engine);assert.equal(phone.json.engine.auto,true);assert.equal(app.snapshot().pairedDevices,1);
}));
test('remembered phone access does not cross Binance accounts and revocation survives restart',()=>fixture(async({request,connect,pair,restart})=>{
 await connect();const p=await pair(),options={mobile:true,cookie:p.cookie};await restart();await connect(null,'B'.repeat(64));assert.equal((await request('/mobile/status',undefined,options)).status,401);
 const other=await pair();await request('/host/revoke',{});await restart();assert.equal((await request('/mobile/status',undefined,{mobile:true,cookie:other.cookie})).status,401);
}));
test('unused phone trust expires while active trust renews with secure cookies',()=>fixture(async({request,connect,pair,restart,advance})=>{
 await connect();const p=await pair(),options={mobile:true,cookie:p.cookie};advance(16*86400000);const renewed=await request('/mobile/status',undefined,options);assert.equal(renewed.status,200);assert.match(renewed.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=2592000/);
 await restart();advance(15*86400000);assert.equal((await request('/mobile/status',undefined,options)).status,200);advance(31*86400000);assert.equal((await request('/mobile/status',undefined,options)).status,401);
}));
test('phone link remembers an address without exposing API keys or the laptop token',()=>fixture(async({request,connect})=>{
 await connect();const result=await request('/host/pair',{origin:ORIGIN});const u=new URL(result.json.url),params=new URLSearchParams(u.hash.slice(1));assert.equal(u.origin,'https://rzwntm47-art.github.io');assert.equal(params.get('mobileOrigin'),ORIGIN);assert.equal(params.get('pair').length,43);
 assert.ok(!result.json.url.includes(KEY));assert.ok(!result.json.url.includes(TOKEN));
 const next=await request('/host/pair',{});assert.equal(next.status,200);assert.equal(new URLSearchParams(new URL(next.json.url).hash.slice(1)).get('mobileOrigin'),ORIGIN);
}));
test('private address configured after startup is picked up without copying it into the dashboard',()=>fixture(async({request,connect,dataDir})=>{
 await connect();fs.writeFileSync(path.join(dataDir,'mobile-origin.json'),JSON.stringify({origin:ORIGIN}));assert.equal((await request('/host/status')).json.remoteOrigin,ORIGIN);assert.equal((await request('/host/pair',{})).status,200);
}));
test('private mobile app installs at its own controller address without caching account data',()=>fixture(async({request,connect,pair})=>{
 await connect();await pair();const manifest=await request('/mobile/manifest.webmanifest',undefined,{mobile:true});assert.equal(manifest.status,200);assert.equal(manifest.json.start_url,'/mobile');assert.equal(manifest.json.display,'standalone');assert.ok(!manifest.text.includes(KEY));
 const page=await request('/mobile',undefined,{mobile:true});assert.match(page.text,/rel="manifest" href="\/mobile\/manifest.webmanifest"/);assert.match(page.headers.get('cache-control'),/no-store/);assert.match(page.headers.get('content-security-policy'),/manifest-src 'self'/);
 const icon=await request('/mobile/icon.svg',undefined,{mobile:true});assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/image\/svg/);
 assert.equal((await request('/mobile/status',undefined,{mobile:true})).status,401);
}));


