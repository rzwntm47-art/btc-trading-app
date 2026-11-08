'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {main,preflight,prepareRestart}=require('./launch-desktop.cjs');
const {loadLocalToken}=require('./desktop.cjs');
const token='test-token-0123456789012345678901234567';
const state={version:2,service:'btc-demo-laptop',restartSupported:true,generation:'first'};
const refused=()=>{throw Object.assign(Error('fetch failed'),{cause:{code:'ECONNREFUSED'}});};
function sequence(items){const calls=[];return {calls,fetcher:async(url,options)=>{calls.push({url,options});const item=items.shift();assert.notEqual(item,undefined,'unexpected request');return typeof item==='function'?item():Response.json(item.body??item,{status:item.status??200});}};}
const run=f=>prepareRestart({token,fetcher:f.fetcher,wait:async()=>{},log(){}});
test('launcher validates Node and extracted companion folders before touching an existing service',()=>{
  assert.throws(()=>preflight({nodeVersion:'20.19.0'}),/22 or newer/);
  preflight({nodeVersion:'22.0.0'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-preflight-'));
  try{assert.throws(()=>preflight({dir}),/Extract the whole ZIP/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('free port proceeds without sending a restart',async()=>{const f=sequence([refused]);await run(f);assert.equal(f.calls.length,1);});
test('existing connector receives one authenticated generation-bound restart and port release is verified',async()=>{
  const f=sequence([state,{status:202,body:{ok:true,generation:'first'}},{...state,restarting:true},refused]);await run(f);
  assert.equal(f.calls.length,4);const request=f.calls[1];assert.ok(request.url.endsWith('/host/restart'));assert.equal(request.options.headers.Authorization,'Bearer '+token);assert.deepEqual(JSON.parse(request.options.body),{generation:'first'});
});
test('older connector, wrong token, unrelated port and uncertain reachability never trigger a restart',async()=>{
  for(const [response,pattern] of [[{version:2,generation:'legacy'},/older connector/],[{status:404},/older connector/],[{status:401},/different local token/],[{service:'something-else'},/unrecognized service/],[()=>{throw Error('timeout');},/Cannot verify/]]){
    const f=sequence([response]);await assert.rejects(run(f),pattern);assert.equal(f.calls.length,1);
  }
});
test('pending or failed restarts never launch another copy',async()=>{
  let f=sequence([{...state,restarting:true}]);await assert.rejects(run(f),/already in progress/);assert.equal(f.calls.length,1);
  f=sequence([state,{status:409,body:{error:'Action still pending'}}]);await assert.rejects(run(f),/Action still pending/);assert.equal(f.calls.length,2);
  f=sequence([state,()=>{throw Error('lost response');}]);await assert.rejects(run(f),/not confirmed/);assert.equal(f.calls.length,2);
});
test('concurrent replacement is detected and an occupied port is never forcefully taken',async()=>{
  const accepted={status:202,body:{ok:true,generation:'first'}};
  let f=sequence([state,accepted,{...state,generation:'second'}]);await assert.rejects(run(f),/Another connector has already started/);
  f=sequence([state,accepted,state]);await assert.rejects(prepareRestart({token,fetcher:f.fetcher,wait:async()=>{},deadlineMs:0,log(){}}),/not released port/);
});
test('local token is stable across launcher runs and invalid saved tokens are not silently replaced',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-token-'));
  try{const first=loadLocalToken(dir,'');assert.ok(first.length>=32);assert.equal(loadLocalToken(dir,''),first);assert.equal(loadLocalToken(dir,token),token);assert.equal(loadLocalToken(dir,''),first);fs.writeFileSync(path.join(dir,'local-token'),'short');assert.throws(()=>loadLocalToken(dir,''),/at least 32/);assert.equal(fs.readFileSync(path.join(dir,'local-token'),'utf8'),'short');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('launching twice replaces the old listener, retains the token, and starts disconnected',async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-main-')),logs=[];let first,second;
 try{
  first=await main({port:0,dataDir,log:s=>logs.push(s)});assert.ok(first?.listening);const port=first.address().port,token=loadLocalToken(dataDir);
  const read=async()=>(await fetch('http://127.0.0.1:'+port+'/host/status',{headers:{Authorization:'Bearer '+token}})).json();
  const initial=await read();second=await main({port,dataDir,log:s=>logs.push(s)});assert.ok(second?.listening);assert.equal(first.listening,false);assert.equal(loadLocalToken(dataDir),token);
  const restarted=await read();assert.notEqual(restarted.generation,initial.generation);assert.equal(restarted.engine,null);assert.equal(restarted.restarting,false);assert.ok(logs.some(s=>s.includes('This connector has stopped')));
 }finally{for(const server of [first,second])if(server?.listening)await new Promise(r=>server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});}
});
