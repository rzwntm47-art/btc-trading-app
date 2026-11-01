'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto}=require('node:crypto');const {DemoEngine}=require('./engine.js');
function fixture({phone=false,fail=false}={}){
 const nodes=new Map(),events={},requests=[],timers=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:false,value:'',textContent:'',classList:{add(){},remove(){}},replaceChildren(){},scrollIntoView(){},removeAttribute(){}});return nodes.get(id);};
 const payload={version:2,generation:'test',pairedDevices:1,serverAt:Date.now(),engine:{state:{version:1,records:[],startedAt:0},connected:true,auto:false,busy:false,controlPending:false,tradingReady:true,account:{assets:[]},positions:[],orders:[],algos:[],symbols:[],scanned:[],income:[],events:[]}};
 const fetcher=async(url,options={})=>{requests.push({url,options});if(fail)throw Error('offline');const body=options.body?JSON.parse(options.body):{};if(url.includes('/pair'))return Response.json({...payload,csrf:'test-csrf'});if(url.includes('/command'))return Response.json({id:body.id,status:'done'});return Response.json(payload);};
 const context=vm.createContext({DemoEngine,console,crypto:webcrypto,Response,URLSearchParams,AbortSignal,setTimeout,clearTimeout,setInterval(fn){timers.push(fn);},fetch:fetcher,document:{getElementById:node,querySelector(){return null;},addEventListener(type,fn){events[type]=fn;}},window:{addEventListener(type,fn){events[type]=fn;}},location:{origin:phone?'https://test.test.ts.net':'https://rzwntm47-art.github.io',pathname:phone?'/mobile':'/',hash:phone?'#pair=test-pairing-code':''},history:{replaceState(...args){context.cleanedUrl=args[2];}},localStorage:{getItem(){return null;}},parent:{},navigator:{},TextEncoder,TextDecoder});
 vm.runInContext(fs.readFileSync(__dirname+'/ui.js','utf8'),context);vm.runInContext('render=()=>{};',context);vm.runInContext(fs.readFileSync(__dirname+'/mobile.js','utf8'),context);
 const ready=()=>vm.runInContext("remoteTransport={base:'http://127.0.0.1:10000',prefix:'/host',token:'test-admin-token'};engine=new RemoteDemo(remoteTransport);engine.connected=true;engine.tradingReady=true;",context);
 return {node,events,requests,context,ready,timers};
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
