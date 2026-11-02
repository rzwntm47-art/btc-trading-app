const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoError}=require('./engine.js');
const {fixture,symbol}=require('./test-fixture.cjs');
async function opened(){const f=fixture();await f.e.enter(symbol,f.signal);f.e.newRules=true;f.e.bandRules=true;f.e.tradingReady=true;return f;}
function legacyExit(f,{missing=false,invalid=false}={}){
 const r=f.e.owned(symbol),e=r.exits[0],a=f.algos.get(e.id);f.algos.delete(e.id);delete e.algoId;e.verifiedAt=0;
 e.id=invalid?'bd1_'+ 'a'.repeat(32)+'_sl6_1000':e.id;a.clientAlgoId=e.id;if(!missing)f.algos.set(e.id,a);return {r,e,a};
}
function rejectClientReferences(f){const base=f.api.call,requests=[];f.api.call=async(m,p,q,s)=>{
 if(p==='/fapi/v1/algoOrder'&&m!=='POST'&&q.clientAlgoId!==undefined){requests.push({m,q});throw new DemoError('invalid client ID',-4015);}return base(m,p,q,s);
 };return requests;}
for(const invalid of [false,true])test('Start repairs '+(invalid?'overlength':'exchange-rejected')+' stale stop IDs only after fresh flat confirmation',async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid});f.position=null;f.algos.clear();rejectClientReferences(f);f.e.pause('Stopped');
 await f.e.start();assert.equal(f.e.auto,true);assert.ok(r.closedAt);assert.equal(e.cancelled,true);assert.match(e.recoveryReason,/position confirmed flat/);
 assert.ok(f.calls.some(c=>c.path==='/fapi/v3/positionRisk'&&c.p.symbol===symbol));assert.equal(f.e.state.records.length,1);
 const before=f.calls.length;await f.e.reconcile();assert.equal(f.calls.length,before);
});
test('a running tick cleans stale stops, keeps Auto enabled and continues scanning without another Start',async()=>{
 const f=await opened(),{r}=legacyExit(f,{missing:true});f.position=null;f.algos.clear();rejectClientReferences(f);let scans=0;f.e.scan=async()=>scans++;
 await f.e.tick();assert.equal(f.e.auto,true);assert.ok(r.closedAt);assert.equal(scans,1);assert.equal(f.e.block,'');
 await f.e.tick();assert.equal(f.e.auto,true);assert.equal(scans,2);
});
test('new stops retain Binance numeric IDs and query/cancel without sending the client ID',async()=>{
 const f=await opened(),r=f.e.owned(symbol),e=r.exits[0];assert.equal(typeof e.algoId,'string');assert.equal(e.id.length,28);
 const before=f.calls.length;assert.equal((await f.e.queryExit(e)).algoStatus,'NEW');await f.e.cancelExits(r);
 const requests=f.calls.slice(before).filter(c=>c.path==='/fapi/v1/algoOrder');assert.ok(requests.length>=2);assert.ok(requests.every(c=>c.p.algoId&&c.p.clientAlgoId===undefined));assert.equal(f.e.auto,true);
});
test('long parent IDs and thousands of historical replacements cannot lengthen new stop IDs',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.id='x'.repeat(36);r.exits.push(...Array.from({length:1001},(_,i)=>({id:r.id+'_sl6_'+i,kind:'sl6',cancelled:true})));
 await f.e.ensureExit(r,f.position,'sl6',-6,true);const first=r.exits.at(-1);await f.e.ensureExit(r,f.position,'sl6',-6,true);const second=r.exits.at(-1);
 for(const e of [first,second]){assert.match(e.id,/^bdx_[a-f0-9]{24}$/);assert.ok(e.algoId);assert.equal(e.confirmed,true);}assert.notEqual(first.id,second.id);
});
for(const invalid of [false,true])test('legacy '+(invalid?'overlength':'valid-format')+' reference recovers by exact open-order match and cancels by numeric ID',async()=>{
 const f=await opened(),{r,e,a}=legacyExit(f,{invalid}),rejected=rejectClientReferences(f);
 const result=await f.e.queryExit(e);assert.equal(result.algoStatus,'NEW');assert.equal(e.algoId,String(a.algoId));
 await f.e.cancelExits(r);assert.equal(a.algoStatus,'CANCELED');assert.equal(e.cancelled,true);assert.equal(f.e.auto,true);
 assert.ok(f.calls.some(c=>c.path==='/fapi/v1/openAlgoOrders'&&c.p.symbol===symbol));assert.equal(rejected.length,invalid?0:1);
});
test('a definite client-ID cancellation rejection retries once using the recovered numeric ID',async()=>{
 const f=await opened(),{r,e}=legacyExit(f),rejected=rejectClientReferences(f);await f.e.cancelExits(r);
 assert.equal(rejected.filter(c=>c.m==='DELETE').length,1);assert.ok(e.algoId);assert.equal(e.cancelled,true);assert.ok(f.calls.some(c=>c.method==='DELETE'&&String(c.p.algoId)===e.algoId));
});
test('absent invalid references are not cleared when Binance still reports a live position',async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid:true});f.e.positions=[];
 await assert.rejects(()=>f.e.cancelExits(r),/checking position/);assert.equal(e.cancelled,undefined);assert.ok(f.position);assert.ok(!r.closedAt);
});
test('a stale old exit can be retired while a fresh replacement loss stop is verified',async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid:true});await f.e.ensureExit(r,f.position,'sl6',-6,true);const keep=r.exits.at(-1);
 await f.e.cancelExits(r,keep.id);assert.equal(e.cancelled,true);assert.equal(keep.cancelled,undefined);assert.equal(keep.confirmed,true);assert.equal(f.algos.get(keep.id).algoStatus,'NEW');assert.ok(f.position);assert.equal(f.e.auto,true);
});
test('a take-profit order alone cannot prove replacement loss protection',async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid:true}),profit=r.exits.find(x=>x.kind==='tp');
 await assert.rejects(()=>f.e.cancelExits(r,profit.id),/checking position/);assert.equal(e.cancelled,undefined);assert.ok(f.position);
});
test('cleanup never matches a truncated ID or cancels a different/manual order',async()=>{
 const f=await opened(),{r,e,a}=legacyExit(f,{missing:true,invalid:true});f.position=null;const manual={...a,clientAlgoId:e.id.slice(0,36),algoId:500};f.algos.set(manual.clientAlgoId,manual);
 await f.e.cancelExits(r);assert.equal(e.cancelled,true);assert.equal(manual.algoStatus,'NEW');assert.ok(!f.calls.some(c=>c.method==='DELETE'&&String(c.p.algoId)==='500'));
});
for(const payload of [{},[{symbol,positionAmt:null}],[{symbol,positionAmt:'oops'}]])test('incomplete fresh position data cannot clear a stale stop '+JSON.stringify(payload),async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid:true}),base=f.api.call;f.position=null;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v3/positionRisk'&&q.symbol===symbol?payload:base(m,p,q,s);
 await assert.rejects(()=>f.e.cancelExits(r),/position check incomplete/);assert.equal(e.cancelled,undefined);
});
for(const code of [429,401,503])test('inventory failure '+code+' does not erase a stale stop record',async()=>{
 const f=await opened(),{r,e}=legacyExit(f,{missing:true,invalid:true}),base=f.api.call;f.position=null;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/openAlgoOrders')throw new DemoError('inventory unavailable',code);return base(m,p,q,s);};
 await assert.rejects(()=>f.e.cancelExits(r),x=>x.code===code);assert.equal(e.cancelled,undefined);assert.ok(!r.closedAt);
});
test('Stop during stale-order recovery wins over the pending Start',async()=>{
 const f=await opened(),{r}=legacyExit(f,{missing:true,invalid:true});f.position=null;f.algos.clear();f.e.pause('Before Start');const base=f.api.call;let release,ready;
 const atRead=new Promise(resolve=>ready=resolve);f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/openAlgoOrders'&&q?.symbol){ready();await new Promise(resolve=>release=resolve);}return base(m,p,q,s);};
 const pending=f.e.start();await atRead;f.e.pause('User Stop');release();await pending;assert.equal(f.e.auto,false);assert.ok(r.closedAt);
});
test('uncertain cancellation is reconciled but never blindly resubmitted',async()=>{
 const f=await opened(),{r,e}=legacyExit(f),base=f.api.call;let writes=0;
 f.api.call=async(m,p,q,s)=>{if(m==='DELETE'&&p==='/fapi/v1/algoOrder'){writes++;throw new DemoError('timeout',0,true);}return base(m,p,q,s);};
 await assert.rejects(()=>f.e.cancelExits(r),x=>x.uncertain);assert.equal(writes,1);assert.equal(e.cancelled,undefined);
});
test('an accepted stop with a lost response is recovered exactly once and its numeric ID retained',async()=>{
 const f=await opened(),r=f.e.owned(symbol),base=f.api.call;let writes=0;f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/algoOrder'){writes++;throw new DemoError('timeout',0,true);}return result;};
 await f.e.ensureExit(r,f.position,'sl6',-6,true);assert.equal(writes,1);const e=r.exits.at(-1);assert.ok(e.algoId);assert.equal(e.confirmed,true);
});
test('definite -4015 on a new protection write remains a rejection, not an unknown accepted order',async()=>{
 const f=await opened(),r=f.e.owned(symbol),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/algoOrder'){if(m==='POST')throw new DemoError('invalid ID',-4015);if(m==='GET')reads++;}return base(m,p,q,s);};
 await assert.rejects(()=>f.e.ensureExit(r,f.position,'sl6',-6,true),x=>x.code===-4015&&!x.uncertain);assert.equal(reads,0);assert.equal(r.exits.at(-1).cancelled,true);
});
test('a returned order with the wrong identity is never accepted as bot protection',async()=>{
 const f=await opened(),{e}=legacyExit(f),base=f.api.call;f.api.call=async(m,p,q,s)=>m==='GET'&&p==='/fapi/v1/algoOrder'?{algoId:99,clientAlgoId:'someone_else',symbol,algoStatus:'NEW'}:base(m,p,q,s);
 await assert.rejects(()=>f.e.queryExit(e),/identity does not match/);assert.equal(e.algoId,undefined);
});
test('numeric order IDs represented as strings are not rounded through JavaScript Number',async()=>{
 const f=await opened(),r=f.e.owned(symbol),e=r.exits[0],a=f.algos.get(e.id);a.algoId='9007199254740993';e.algoId=a.algoId;
 await f.e.queryExit(e);assert.deepEqual(f.calls.at(-1).p,{algoId:'9007199254740993'});
});
function readFailure(code=503){const error=new DemoError('Temporary account read failed',code);error.requestMethod='GET';error.requestPath='/fapi/v3/account';return error;}
test('Start retries a temporary startup read and completes all checks before scanning',async()=>{
 const f=fixture();f.e.newRules=true;f.e.bandRules=true;f.e.pause('Before Start');let fail=true,prepares=0,scans=0;
 f.e.prepareTrading=async()=>{prepares++;if(fail)throw readFailure();await f.e.refresh();f.e.tradingReady=true;};f.e.scan=async()=>scans++;
 await f.e.start();assert.equal(f.e.auto,true);assert.equal(f.e.startPending,true);assert.ok(f.e.retryAt>Date.now());assert.equal(scans,0);
 await f.e.tick();assert.equal(prepares,1);assert.equal(scans,0);await f.e.enter(symbol,f.signal);assert.equal(f.e.state.records.length,0);
 fail=false;f.e.retryAt=0;await f.e.tick();assert.equal(prepares,2);assert.equal(f.e.startPending,false);assert.equal(f.e.auto,true);assert.equal(scans,1);
});
test('repeated temporary Start failures back off without requiring another click',async()=>{
 const f=fixture();f.e.pause('Before Start');let attempts=0;f.e.prepareTrading=async()=>{attempts++;throw readFailure();};
 await f.e.start();assert.equal(f.e.retryAttempt,1);f.e.retryAt=0;await f.e.tick();assert.equal(f.e.retryAttempt,2);assert.equal(attempts,2);assert.equal(f.e.startPending,true);assert.equal(f.e.auto,true);
});
test('manual Stop cancels a scheduled Start retry permanently',async()=>{
 const f=fixture();f.e.pause('Before Start');let attempts=0;f.e.prepareTrading=async()=>{attempts++;throw readFailure();};
 await f.e.start();f.e.pause('User Stop');await f.e.tick();assert.equal(attempts,1);assert.equal(f.e.auto,false);assert.equal(f.e.startPending,false);assert.equal(f.e.retryAt,0);
});
for(const code of [401,-1022])test('startup authentication failure '+code+' is not automatically retried',async()=>{
 const f=fixture();f.e.pause('Before Start');f.e.prepareTrading=async()=>{throw readFailure(code);};
 await assert.rejects(()=>f.e.start(),e=>e.code===code);assert.equal(f.e.auto,false);assert.equal(f.e.startPending,false);assert.equal(f.e.retryAt,0);
});
test('Stop during a failed startup read cannot schedule a restart afterward',async()=>{
 const f=fixture();f.e.pause('Before Start');let release;f.e.prepareTrading=()=>new Promise((_,reject)=>release=reject);
 const pending=f.e.start();f.e.pause('User Stop');release(readFailure());await assert.rejects(()=>pending,/Temporary account/);assert.equal(f.e.auto,false);assert.equal(f.e.startPending,false);assert.equal(f.e.retryAt,0);
});
