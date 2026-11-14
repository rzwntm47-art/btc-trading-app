'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const core=require('./phone-link-core.js');
const flush=()=>new Promise(r=>setImmediate(r));
function hostFixture(){
 let now=100000,active,calls=[];
 const engine={appVersion:'1.83.1',connected:true,auto:false,tradingReady:true,state:{records:[]},api:{key:'secret-api-key',secret:'secret-hmac',relayToken:'secret-local-token'},transport:{token:'secret-host-token'},income:[],account:{assets:[]},events:[],scanned:[],
  async control(fn){await fn();return true;},async start(){calls.push('start');this.auto=true;},pause(){calls.push('stop');this.auto=false;},async close(symbol){calls.push('close:'+symbol);},owned(symbol){return symbol==='BTCUSDT';},async refresh(){calls.push('refresh');},async reconcile(){calls.push('reconcile');},async updateIncome(){calls.push('income');},async resetResult(){calls.push('resetResult');return {net:0};},async freshTradeReport(){return {reportType:'trade-report'};}};
 active=engine;const host=core.host({getEngine:()=>active,engine,now:()=>now});
 const command=(action,extra={})=>({id:'command-000000000001',action,expires:now+15000,...extra});
 return {engine,host,calls,command,replace(){active={...engine};},advance(ms){now+=ms;}};
}
test('phone payload and snapshot exclude all account signing and relay credentials',()=>{
 const f=hostFixture(),text=JSON.stringify(f.host.handle('/status'));
 for(const secret of Object.values(f.engine.api).concat(f.engine.transport.token))assert.ok(!text.includes(secret));
 assert.equal(JSON.parse(text).engine.appVersion,'1.83.1');
});
test('phone snapshot keeps every open trade and all income for accurate net results',()=>{
 const f=hostFixture();f.engine.state.records=Array.from({length:400},(_,i)=>({id:i,closedAt:i===0?null:1}));f.engine.income=Array.from({length:600},()=>({income:'1'}));
 const snap=f.host.handle('/status');assert.equal(snap.engine.income.length,600);assert.equal(snap.engine.state.records[0].id,0);assert.equal(snap.engine.state.records.length,151);
});
test('phone encryption authenticates both directions and rejects incorrect keys, tampering and reflected packets',async()=>{
 const key=core.random(),laptop=await core.codec(key,'laptop'),phone=await core.codec(key,'phone'),wrong=await core.codec(core.random(),'phone');
 const packet=await laptop.seal({balance:5000,action:'stop'});assert.deepEqual(await phone.open(packet),{balance:5000,action:'stop'});assert.ok(!JSON.stringify(packet).includes('balance'));
 await assert.rejects(wrong.open(packet));await assert.rejects(laptop.open(packet));await assert.rejects(phone.open({...packet,body:'A'+packet.body.slice(1,-1)+'B'}));
 assert.deepEqual(await laptop.open(await phone.seal({ok:true})),{ok:true});
});
test('malformed or excessive encrypted packets fail without being processed',async()=>{
 const c=await core.codec(core.random(),'phone');for(const packet of [null,{}, {v:1,iv:'x'.repeat(16),body:'x'.repeat(1500001)}])await assert.rejects(c.open(packet));
 await assert.rejects(core.codec('short','phone'));await assert.rejects(c.seal({data:'x'.repeat(750001)}));
});
test('replayed command IDs execute once and cannot be changed to a different action',async()=>{
 const f=hostFixture(),command=f.command('close',{symbol:'BTCUSDT'});f.host.handle('/command',command);f.host.handle('/command',command);await flush();assert.deepEqual(f.calls,['close:BTCUSDT']);
 assert.equal(f.host.handle('/command?id='+command.id).status,'done');assert.throws(()=>f.host.handle('/command',{...command,action:'start'}),/ID already used/);
});
test('expired commands never execute and pending expiry is checked again before execution',async()=>{
 const f=hostFixture();assert.throws(()=>f.host.handle('/command',f.command('start',{expires:99999})),/expired/);assert.deepEqual(f.calls,[]);
 let continueControl;f.engine.control=fn=>new Promise((resolve,reject)=>{continueControl=()=>fn().then(()=>resolve(true),reject);});
 const cmd=f.command('start');f.host.handle('/command',cmd);f.advance(16000);continueControl();await flush();assert.deepEqual(f.calls,[]);assert.equal(f.host.handle('/command?id='+cmd.id).status,'error');
});
test('phone can stop and sync the existing engine without making another writer',async()=>{
 const f=hostFixture();f.engine.auto=true;f.host.handle('/command',f.command('stop'));assert.equal(f.engine.auto,false);
 f.host.handle('/command',f.command('refresh',{id:'command-000000000002'}));await flush();assert.deepEqual(f.calls,['stop','refresh','reconcile','income']);
});
test('unsupported actions, unmanaged positions and direct exchange paths are rejected',async()=>{
 const f=hostFixture();for(const action of ['order','disconnect','reset','startTrial','setLeverage'])assert.throws(()=>f.host.handle('/command',f.command(action)),/Unsupported/);
 assert.throws(()=>f.host.handle('/relay',{key:'x'}),/Unsupported/);
 const cmd=f.command('close',{symbol:'ETHUSDT'});f.host.handle('/command',cmd);await flush();assert.equal(f.host.handle('/command?id='+cmd.id).status,'error');assert.deepEqual(f.calls,[]);
});
test('revoked and changed-account links cannot read or command the next account',()=>{
 for(const change of ['revoke','replace','disconnect']){const f=hostFixture();if(change==='revoke')f.host.revoke();if(change==='replace')f.replace();if(change==='disconnect')f.engine.connected=false;assert.equal(f.host.valid(),false);assert.throws(()=>f.host.handle('/status'));assert.throws(()=>f.host.handle('/command',f.command('start')));assert.deepEqual(f.calls,[]);}
});
test('phone control respects busy actions and carries reset confirmation',async()=>{
 const f=hostFixture();f.engine.controlPending=true;assert.equal(f.host.handle('/command',f.command('start')).status,'error');assert.deepEqual(f.calls,[]);f.engine.controlPending=false;
 const cmd=f.command('resetResult',{id:'command-000000000002'});f.host.handle('/command',cmd);await flush();assert.deepEqual(f.host.handle('/command?id='+cmd.id).reset,{net:0});
});
test('an unconfirmed background Stop never reports successful completion',async()=>{
 const f=hostFixture();f.engine.remote=true;f.engine.controlPending=true;f.engine.command=async()=>{throw Error('Stop not confirmed');};const cmd=f.command('stop');f.host.handle('/command',cmd);await flush();assert.equal(f.host.handle('/command?id='+cmd.id).status,'error');assert.equal(f.host.handle('/command?id='+cmd.id).error,'Stop not confirmed');assert.deepEqual(f.calls,[]);
});
test('direct phone URL is recognized before old private-origin redirects and credentials are hidden',()=>{
 const source=fs.readFileSync(__dirname+'/mobile.js','utf8');assert.match(source,/const onPhoneController=location.pathname==='\/mobile'\|\|onLinkPhone/);assert.match(source,/if\(onPhoneController&&!onLinkPhone\)/);
 const html=fs.readFileSync(__dirname+'/demo-connect.html','utf8');assert.match(html,/<button id="connect"[^>]*>[^<]*<\/button><button id="createPhoneLink"/);
 for(const [index,script] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries())assert.doesNotThrow(()=>new vm.Script(script[1]),'Generated script '+index);
});

function browserPair(){
 const peers=new Map(),connections=[],network=[],contexts=[];
 class Events{constructor(){this.handlers=new Map();}on(name,fn){const list=this.handlers.get(name)||[];list.push(fn);this.handlers.set(name,list);}emit(name,value){for(const fn of this.handlers.get(name)||[])fn(value);}}
 class Connection extends Events{constructor(){super();this.open=false;}send(data){if(!this.open)throw Error('closed');network.push(structuredClone(data));queueMicrotask(()=>{if(this.other.open)this.other.emit('data',structuredClone(data));});}close(){if(!this.open)return;this.open=false;this.emit('close');if(this.other.open){this.other.open=false;this.other.emit('close');}}}
 class Peer extends Events{constructor(id){super();this.id=id;peers.set(id,this);queueMicrotask(()=>{this.open=true;this.emit('open',id);});}connect(id){const local=new Connection(),remote=new Connection();local.other=remote;remote.other=local;connections.push(local,remote);queueMicrotask(()=>{const target=peers.get(id);if(!target){local.emit('error',Error('not found'));return;}target.emit('connection',remote);local.open=remote.open=true;local.emit('open');remote.emit('open');});return local;}destroy(){this.destroyed=true;peers.delete(this.id);for(const c of connections)c.close();}reconnect(){}}
 function page(url){
  const nodes=new Map(),storage=new Map(),events={},intervals=[];let context;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,classList:{add(){},remove(){}},replaceChildren(){},scrollIntoView(){},focus(){},select(){},removeAttribute(){}});return nodes.get(id);};
  const location=new URL(url),sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const calls=[];
  context=vm.createContext({DemoEngine:require('./engine.js').DemoEngine,APP_VERSION:'1.83.1',SESSION_TARGET:20,Peer,RTCPeerConnection:function(){},console,crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,AbortSignal,btoa,atob,Response,
   setTimeout(fn,ms){const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,setInterval(fn){intervals.push(fn);},
   fetch:async()=>{throw Error('Phone links must not request laptop HTTP or Binance endpoints');},
   location,history:{replaceState(_a,_b,path){const u=new URL(path,location);location.href=u.href;}},
   localStorage:{getItem(){return null;},setItem(){},removeItem(){}},sessionStorage,
   navigator:{clipboard:{async writeText(text){context.copied=text;}}},parent:{},
   document:{getElementById:node,querySelector(){return null;},addEventListener(type,fn){events[type]=fn;}},
   window:{location:{replace(){throw Error('Unexpected old private-origin redirect');}},addEventListener(type,fn){events[type]=fn;}},calls
  });
  vm.runInContext(fs.readFileSync(__dirname+'/ui.js','utf8'),context);vm.runInContext('render=()=>{};queueRender=()=>{};',context);
  for(const name of ['mobile.js','phone-link-core.js','phone-link.js'])vm.runInContext(fs.readFileSync(__dirname+'/'+name,'utf8'),context);
  contexts.push(context);return {context,node,storage,events,intervals,calls};
 }
 return {page,network,connections,cleanup(){for(const context of contexts)vm.runInContext('if(directPhoneHost)revokeDirectPhone();closePhoneClient();',context);}};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Condition not reached');}
test('browser flow creates a link from an existing connection, pairs, starts/stops and revokes without a connector upgrade',async()=>{
 const b=browserPair();try{
  const laptop=b.page('https://rzwntm47-art.github.io/btc-trading-app/demo-connect.html');
  await laptop.node('createPhoneLink').onclick();assert.match(laptop.node('directPhoneStatus').textContent,/Connect Binance Demo above first/);
  vm.runInContext("engine=new DemoEngine({key:'private-api-key',relayToken:'private-relay-token',offset:0},null,()=>{});engine.connected=true;engine.tradingReady=true;engine.account={assets:[]};engine.start=async()=>{calls.push('start');engine.auto=true;};engine.pause=()=>{calls.push('stop');engine.auto=false;};engine.control=async fn=>{await fn();return true;};",laptop.context);
  const original=vm.runInContext('engine',laptop.context);await laptop.node('createPhoneLinkToolbar').onclick();const link=laptop.node('directPhoneLink').value;assert.match(link,/\?phone=1#peer=btc-/);assert.ok(!link.includes('private-'));assert.equal(vm.runInContext('engine',laptop.context),original);assert.deepEqual(laptop.calls,[]);
  await laptop.node('copyDirectPhoneLink').onclick();assert.equal(laptop.context.copied,link);
  const phone=b.page(link);await until(()=>vm.runInContext('engine?.connected',phone.context));assert.equal(phone.node('credentials').hidden,true);assert.equal(phone.context.location.hash,'');
  assert.equal(vm.runInContext('engine.remote',phone.context),true);assert.equal(vm.runInContext('engine.entryPolicy.minimumPositionNotional',phone.context),150);
  await vm.runInContext("engine.command('start')",phone.context);assert.deepEqual(laptop.calls,['start']);assert.equal(vm.runInContext('engine.auto',phone.context),true);
  await vm.runInContext("engine.command('stop')",phone.context);assert.deepEqual(laptop.calls,['start','stop']);assert.equal(vm.runInContext('engine.auto',phone.context),false);
  const wire=JSON.stringify(b.network);for(const text of ['private-api-key','private-relay-token','minimumPositionNotional','"action"','"account"'])assert.ok(!wire.includes(text),'Leaked '+text);
  laptop.node('revokeDirectPhone').onclick();await flush();assert.equal(vm.runInContext('engine.connected',phone.context),false);assert.equal(original.connected,true);assert.deepEqual(laptop.calls,['start','stop']);
 }finally{b.cleanup();}
});
