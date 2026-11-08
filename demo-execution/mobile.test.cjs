'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto}=require('node:crypto');const {DemoEngine,SESSION_TARGET}=require('./engine.js');
function fixture({phone=false,fail=false}={}){
 const nodes=new Map(),events={},requests=[],timers=[],storage=new Map(),navigations=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:false,value:'',textContent:'',classList:{add(){},remove(){}},replaceChildren(){},scrollIntoView(){},removeAttribute(){}});return nodes.get(id);};
 const payload={version:2,generation:'test',pairedDevices:1,serverAt:Date.now(),engine:{state:{version:1,records:[],startedAt:0},connected:true,auto:false,busy:false,controlPending:false,tradingReady:true,account:{assets:[]},positions:[],orders:[],algos:[],symbols:[],scanned:[],income:[],events:[]}};
 const fetcher=async(url,options={})=>{requests.push({url,options});if(fail)throw Error('offline');const body=options.body?JSON.parse(options.body):{};if(url.includes('/pair'))return Response.json({...payload,csrf:'test-csrf'});if(url.includes('/command'))return Response.json({id:body.id,status:'done'});return Response.json(payload);};
 const context=vm.createContext({DemoEngine,SESSION_TARGET,console,crypto:webcrypto,Response,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,setInterval(fn){timers.push(fn);},fetch:fetcher,document:{getElementById:node,querySelector(){return null;},addEventListener(type,fn){events[type]=fn;}},window:{location:{replace(url){navigations.push(url);}},addEventListener(type,fn){events[type]=fn;}},location:{origin:phone?'https://test.test.ts.net':'https://rzwntm47-art.github.io',pathname:phone?'/mobile':'/',hash:phone?'#pair=test-pairing-code':''},history:{replaceState(...args){context.cleanedUrl=args[2];}},localStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,value);},removeItem(key){storage.delete(key);}},parent:{},navigator:{},TextEncoder,TextDecoder});
 vm.runInContext(fs.readFileSync(__dirname+'/ui.js','utf8'),context);vm.runInContext('render=()=>{};',context);vm.runInContext(fs.readFileSync(__dirname+'/mobile.js','utf8'),context);
 const ready=()=>vm.runInContext("remoteTransport={base:'http://127.0.0.1:10000',prefix:'/host',token:'test-admin-token'};engine=new RemoteDemo(remoteTransport);engine.connected=true;engine.tradingReady=true;",context);
 return {node,events,requests,context,ready,timers,payload,storage,navigations,setOffline(value){fail=value;}};
}
test('Pair Mobile opens and missing connector credentials produce a visible setup message',async()=>{
 const f=fixture();f.node('pairPanel').hidden=true;f.node('pairMobile').onclick();assert.equal(f.node('pairPanel').hidden,false);
 await f.node('connectBackground').onclick();assert.match(f.node('pairStatus').textContent,/local token/);assert.equal(f.requests.length,0);
});
test('closing a remote dashboard does not send Stop, clear credentials, or execute a browser tick',()=>{
 const f=fixture();f.ready();f.events.pagehide();for(const timer of f.timers.slice(0,1))timer();assert.equal(f.requests.length,0);
});
test('remote Start and Close send explicit idempotent commands without Binance credentials',async()=>{
 const f=fixture();f.ready();await f.node('start').onclick();await vm.runInContext("engine.close('BTCUSDT')",f.context);
 const commands=f.requests.filter(x=>x.url.endsWith('/command')).map(x=>JSON.parse(x.options.body));assert.deepEqual(commands.map(x=>x.action),['start','close']);assert.equal(commands[1].symbol,'BTCUSDT');assert.notEqual(commands[0].id,commands[1].id);
 for(const command of commands){assert.equal(command.key,undefined);assert.equal(command.secret,undefined);assert.ok(command.id.length>=16);}
});
test('losing the network disables controls without claiming or sending a Stop',async()=>{
 const f=fixture({fail:true});f.ready();await vm.runInContext('pollRemote()',f.context);assert.equal(vm.runInContext('engine.connected',f.context),false);assert.match(f.node('status').textContent,/may still be trading/);assert.ok(f.requests.every(x=>!x.url.includes('/command')));
});
test('reset waits for an overlapping old poll, then fetches the confirmed zero snapshot',async()=>{
 const f=fixture();f.ready();Object.assign(f.payload.engine,{resultResetSupported:true,appVersion:'1.74',income:[{income:'-39.44',incomeType:'REALIZED_PNL'}],lastIncome:Date.now(),incomeWindowStart:100,state:{version:1,records:[],startedAt:100}});
 f.context.initial=f.payload;vm.runInContext('engine.apply(initial)',f.context);let releaseOld,reads=0,commands=0,finished=false;
 const old=JSON.parse(JSON.stringify(f.payload));
 f.context.fetch=async(url,options={})=>{
  if(url.endsWith('/status')){reads++;if(reads===1)return new Promise(r=>releaseOld=()=>r(Response.json(old)));return Response.json(f.payload);}
  const input=JSON.parse(options.body);assert.equal(input.action,'resetResult');commands++;const at=Date.now();Object.assign(f.payload.engine,{income:[],lastIncome:at,incomeWindowStart:at,incomeWindowEnd:at,auto:false,state:{version:1,records:[],startedAt:at,resetAt:at,dayOpenPnl:0,resultResetSequence:1}});
  return Response.json({id:input.id,status:'done',reset:{at,sequence:1,net:0,openingUnrealized:0}});
 };
 const oldPoll=vm.runInContext('pollRemote()',f.context),reset=f.node('resetResult').onclick().then(()=>{finished=true;});await new Promise(r=>setImmediate(r));assert.equal(commands,1);assert.equal(finished,false);
 releaseOld();await oldPoll;await reset;assert.equal(reads,2);assert.equal(commands,1);assert.equal(vm.runInContext('engine.sessionNet()',f.context),0);assert.match(f.node('resultResetMessage').textContent,/Reset confirmed/);
 await vm.runInContext('pollRemote()',f.context);assert.match(f.node('resultResetMessage').textContent,/Reset confirmed/);
});
test('an old connector cannot inherit the website reset capability or receive an unsupported reset',async()=>{
 const f=fixture();f.ready();f.payload.engine.appVersion='1.73';await vm.runInContext('pollRemote()',f.context);await f.node('resetResult').onclick();
 assert.equal(vm.runInContext('engine.resultResetSupported',f.context),false);assert.match(f.node('resultResetMessage').textContent,/V1.73/);assert.equal(f.node('resultResetUpdate').hidden,false);assert.ok(f.requests.every(r=>r.url.endsWith('/status')));
});
test('a remote reset rejection remains visible beside the amount after polling resumes',async()=>{
 const f=fixture();f.ready();f.payload.engine.resultResetSupported=true;await vm.runInContext('pollRemote()',f.context);
 f.context.fetch=async(url,options={})=>url.endsWith('/command')?Response.json({status:'error',error:'Account read failed'}):Response.json(f.payload);
 await f.node('resetResult').onclick();await vm.runInContext('pollRemote()',f.context);assert.match(f.node('resultResetMessage').textContent,/Reset not confirmed: Account read failed/);assert.ok(!f.node('resultResetMessage').textContent.startsWith('Reset confirmed'));
});
test('restarted laptop exposes credentials and reconnect instructions without replaying any command',async()=>{
 const f=fixture();f.ready();f.node('credentials').hidden=true;f.node('pairPanel').hidden=true;
 vm.runInContext("engine.state.goalStopAt=123;engine.positions=[{symbol:'BTCUSDT'}];engine.auto=true;",f.context);
 f.payload.engine=null;f.payload.connectorVersion='1.72';f.payload.generation='restarted';await vm.runInContext('pollRemote()',f.context);
 assert.equal(f.node('credentials').hidden,false);assert.equal(f.node('credentials').open,true);assert.equal(f.node('pairPanel').hidden,false);assert.match(f.node('status').textContent,/unlock saved keys/);
 assert.equal(vm.runInContext('engine.positions.length',f.context),0);assert.equal(vm.runInContext('engine.state.goalStopAt',f.context),undefined);assert.equal(vm.runInContext('engine.appVersion',f.context),'1.72');assert.equal(vm.runInContext('engine.auto',f.context),false);assert.ok(f.requests.every(x=>x.url.endsWith('/status')));
});
test('phone remains a controller after connector restart and never exposes laptop credentials',async()=>{
 const f=fixture({phone:true});await new Promise(r=>setTimeout(r,10));f.payload.engine=null;f.payload.connectorVersion='1.72';await vm.runInContext('pollRemote()',f.context);
 assert.equal(f.node('credentials').hidden,true);assert.equal(f.node('pairMobile').hidden,true);assert.match(f.node('status').textContent,/Reconnect Binance on the laptop; this phone remains paired/);assert.equal(f.requests.filter(x=>x.url==='/mobile/pair').length,1);
});
test('reconnection during restart is blocked and missing credentials can be entered after restart',async()=>{
 const f=fixture();f.ready();f.node('pairToken').value='t'.repeat(43);f.payload.restarting=true;
 await f.node('connectBackground').onclick();assert.match(f.node('pairStatus').textContent,/restart is in progress/);assert.ok(f.requests.every(x=>x.url.endsWith('/status')));
 f.payload.restarting=false;f.payload.engine=null;f.node('credentials').hidden=true;await f.node('connectBackground').onclick();assert.equal(f.node('credentials').hidden,false);assert.equal(f.node('credentials').open,true);assert.match(f.node('pairStatus').textContent,/Connect laptop \/ reconnect controls below/);assert.ok(f.requests.every(x=>x.url.endsWith('/status')));
});
test('returning to the mobile controller reconnects immediately and restores laptop Auto intent',async()=>{
 const f=fixture({fail:true});f.ready();await vm.runInContext('pollRemote()',f.context);assert.equal(vm.runInContext('engine.connected',f.context),false);
 f.setOffline(false);f.payload.engine.auto=true;f.payload.engine.appVersion='1.66';f.payload.engine.entryHold='Order still settling';
 await f.events.visibilitychange();assert.equal(vm.runInContext('engine.connected',f.context),true);assert.equal(vm.runInContext('engine.auto',f.context),true);assert.equal(vm.runInContext('engine.entryHold',f.context),'Order still settling');assert.equal(vm.runInContext('engine.appVersion',f.context),'1.66');
 assert.ok(f.requests.every(x=>x.url.endsWith('/status')));
});
test('network restoration refreshes a visible remote controller without sending trading commands',async()=>{
 const f=fixture();f.ready();vm.runInContext('engine.connected=false;document.hidden=true;',f.context);await f.events.online();assert.equal(f.requests.length,0);
 vm.runInContext('document.hidden=false;',f.context);await f.events.online();assert.equal(f.requests.length,1);assert.ok(f.requests[0].url.endsWith('/status'));assert.equal(vm.runInContext('engine.connected',f.context),true);
});
test('phone pairing removes fragment, exchanges once, hides key fields and uses same-origin session cookies',async()=>{
 const f=fixture({phone:true});await new Promise(r=>setTimeout(r,10));assert.equal(f.context.cleanedUrl,'/mobile');assert.equal(f.node('credentials').hidden,true);assert.equal(f.node('pairMobile').hidden,true);
 const pair=f.requests.find(x=>x.url==='/mobile/pair');assert.ok(pair);assert.equal(pair.options.credentials,'same-origin');assert.equal(pair.options.headers.Authorization,undefined);assert.equal(JSON.parse(pair.options.body).code,'test-pairing-code');
 assert.equal(f.requests.filter(x=>x.url==='/mobile/pair').length,1);assert.ok(f.requests.every(x=>!x.url.includes('binance.com')));
});

test('remote controller never substitutes its new $300 settings for an older laptop engine',()=>{
 const f=fixture();f.ready();
 vm.runInContext("engine.apply({engine:{appVersion:'1.47',connected:true},generation:'old',serverAt:Date.now()})",f.context);
 assert.equal(vm.runInContext('engine.appVersion',f.context),'1.47');assert.equal(vm.runInContext('engine.entryPolicy',f.context),null);
 vm.runInContext("engine.apply({engine:{appVersion:'1.49',connected:true,entryPolicy:{margin:300,maxLeverage:10,strategy:'movers-momentum-v1'}},generation:'new',serverAt:Date.now()})",f.context);
 assert.equal(vm.runInContext('engine.entryPolicy.margin',f.context),300);assert.equal(vm.runInContext('engine.entryPolicy.maxLeverage',f.context),10);
});

test('remote experiment controls send explicit laptop commands, never run local trading logic',async()=>{
 const f=fixture();f.ready();await vm.runInContext('engine.startTrial()',f.context);await vm.runInContext('engine.endTrial()',f.context);
 assert.deepEqual(f.requests.filter(x=>x.url.endsWith('/command')).map(x=>JSON.parse(x.options.body).action),['startTrial','endTrial']);assert.ok(f.requests.every(x=>!x.url.includes('binance.com')));
});
test('one-time phone link remembers only the private address and existing public icon reopens it',()=>{
 const f=fixture(),origin='https://laptop.test.ts.net',code='a'.repeat(43);f.context.location.hash='#mobileOrigin='+encodeURIComponent(origin)+'&pair='+code;
 vm.runInContext('restorePhoneDashboard()',f.context);assert.equal(f.navigations[0],origin+'/mobile#pair='+code);assert.equal(f.context.cleanedUrl,'/');assert.equal(f.storage.get('btc_demo_phone_origin'),origin);assert.ok(![...f.storage.values()].some(v=>v.includes(code)));
 f.context.location.hash='';vm.runInContext('restorePhoneDashboard()',f.context);assert.equal(f.navigations[1],origin+'/mobile');assert.equal(f.requests.length,0);
});
test('phone launch rejects unsafe addresses and can return to the local dashboard explicitly',()=>{
 for(const origin of ['https://evil.example','http://laptop.test.ts.net','https://user:pass@laptop.test.ts.net','https://laptop.test.ts.net/path','https://laptop.test.ts.net:8443']){
  const f=fixture();f.context.location.hash='#mobileOrigin='+encodeURIComponent(origin)+'&pair='+'a'.repeat(43);vm.runInContext('restorePhoneDashboard()',f.context);assert.equal(f.navigations.length,0);assert.equal(f.storage.size,0);
 }
 const f=fixture();f.storage.set('btc_demo_phone_origin','https://laptop.test.ts.net');f.context.location.search='?local=1';vm.runInContext('restorePhoneDashboard()',f.context);assert.equal(f.storage.size,0);assert.equal(f.navigations.length,0);
});
test('saved phone address leaves the embedded public app through the top-level window',()=>{
 const f=fixture(),top=[];f.context.window.top={location:{replace(url){top.push(url);}}};f.storage.set('btc_demo_phone_origin','https://laptop.test.ts.net');vm.runInContext('restorePhoneDashboard()',f.context);assert.deepEqual(top,['https://laptop.test.ts.net/mobile']);assert.equal(f.navigations.length,0);assert.equal(f.requests.length,0);
});


