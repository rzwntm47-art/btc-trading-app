'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine}=require('./engine.js');
const {fixture,symbol}=require('./test-fixture.cjs');
function losing(){const f=fixture();f.e.newRules=true;f.e.syncDaily();f.e.state.dayOpenPnl=0;f.e.income=[{income:'-39.44',incomeType:'REALIZED_PNL',asset:'USDT',time:f.e.state.startedAt}];f.e.lastIncome=Date.now();f.e.incomeWindowStart=f.e.state.startedAt;return f;}
test('counter reset works with a leftover protective order that blocks the old journal reset',async()=>{
 const f=losing();f.algos.set('bd1_protect',{symbol,clientAlgoId:'bd1_protect',algoStatus:'NEW'});
 f.e.state.records=[{id:'bd1_history',symbol,side:'BUY',entryStatus:'FILLED',closedAt:Date.now()-5000}];const records=f.e.state.records;
 await assert.rejects(()=>f.e.resetFromBinance(),/Reset blocked/);assert.equal(f.e.sessionNet(),-39.44);
 f.calls.length=0;const result=await f.e.resetResult();assert.equal(result.net,0);assert.equal(f.e.sessionNet(),0);assert.equal(f.e.state.records,records);assert.equal(f.e.algos.length,1);assert.equal(f.algos.get('bd1_protect').algoStatus,'NEW');assert.equal(f.e.auto,false);
 assert.deepEqual(f.calls.map(c=>c.path).sort(),['/fapi/v3/account','/fapi/v3/positionRisk']);assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.e.state.resultResets.at(-1).previousNet,-39.44);
});
test('counter reset preserves an open position and its exit levels, then counts only later PnL changes',async()=>{
 const f=losing();f.position={symbol,positionSide:'BOTH',positionAmt:'1',entryPrice:'100',markPrice:'97',unRealizedProfit:'-3'};
 const record={id:'bd1_open',symbol,side:'BUY',entryStatus:'FILLED',observedOpen:true,profitFloor:5,peakNet:8,exits:[{id:'bd1_stop',confirmed:true}]};f.e.state.records=[record];
 const result=await f.e.resetResult();assert.equal(result.net,0);assert.equal(result.openingUnrealized,-3);assert.equal(f.e.state.records[0],record);assert.equal(record.profitFloor,5);assert.equal(record.peakNet,8);assert.equal(record.exits[0].confirmed,true);
 f.position.unRealizedProfit='-2';await f.e.refresh({inventory:false,valuation:false});assert.equal(f.e.sessionNet(),1);
 f.position=null;await f.e.refresh({inventory:false,valuation:false});f.e.income=[{incomeType:'REALIZED_PNL',income:'-2'},{incomeType:'COMMISSION',income:'-.1'}];assert.ok(Math.abs(f.e.sessionNet()-.9)<1e-9);assert.equal(record.closedAt,undefined);
});
test('counter reset persists across reconnection and rejects income from before its boundary',async()=>{
 const f=losing(),oldRows=f.e.income;await f.e.resetResult();const state=JSON.parse(JSON.stringify(f.e.state)),base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'?oldRows:base(m,p,q,s);
 const restored=new DemoEngine(f.api,state,()=>{});restored.syncDaily();await restored.refresh({inventory:false,valuation:false});await restored.updateIncome();assert.equal(restored.sessionNet(),0);assert.equal(restored.state.resultResetSequence,1);assert.equal(restored.state.startedAt,state.resetAt);assert.equal(restored.auto,false);
});
test('failed counter persistence does not change the old result or erase its state',async()=>{
 const f=losing(),state=f.e.state;f.e.persist=()=>{throw Error('Storage unavailable');};
 await assert.rejects(()=>f.e.resetResult(),/Storage unavailable/);assert.equal(f.e.state,state);assert.equal(f.e.sessionNet(),-39.44);assert.equal(f.e.state.resultResetSequence,undefined);assert.equal(f.e.auto,false);
});
test('fresh account read failure cannot claim a counter reset',async()=>{
 const f=losing(),state=f.e.state;f.api.call=async()=>{throw Error('Account unavailable');};
 await assert.rejects(()=>f.e.resetResult(),/Account unavailable/);assert.equal(f.e.state,state);assert.equal(f.e.sessionNet(),-39.44);assert.equal(f.e.auto,false);
});
test('repeated explicit resets have distinct confirmations without erasing reset history',async()=>{
 const f=losing();const a=await f.e.resetResult(),b=await f.e.resetResult();assert.equal(b.sequence,a.sequence+1);assert.equal(f.e.state.resultResets.length,2);assert.equal(f.e.sessionNet(),0);assert.equal(f.e.entryPolicy.sessionTarget,20);
});
