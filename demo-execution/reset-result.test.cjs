'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,SESSION_TARGET}=require('./engine.js');
const {fixture,symbol}=require('./test-fixture.cjs');
function losingSession(){
 const f=fixture();f.e.newRules=true;f.e.bandRules=true;f.e.syncDaily();
 f.e.income=[{incomeType:'REALIZED_PNL',asset:'USDT',income:'-39.44',time:f.e.state.startedAt}];
 f.e.lastIncome=Date.now();f.e.incomeWindowStart=f.e.state.startedAt;f.e.incomeWindowEnd=Date.now();
 f.e.state.records=[{id:'bd1_previous',symbol,side:'BUY',entryStatus:'FILLED',closedAt:Date.now()-1000}];
 return f;
}
test('Reset changes -39.44 to zero immediately, archives old trades, and saves the new window',async()=>{
 const f=losingSession();assert.equal(f.e.sessionNet(),-39.44);
 f.e.state.goal=true;f.e.state.goalStopAt=Date.now();f.e.state.goalNet=20;f.e.sessionCloseEstimate={net:-39.44,closingFees:0};
 const previous=f.e.state;await f.e.resetFromBinance();
 assert.equal(f.e.sessionNet(),0);assert.equal(f.e.incomeBreakdown().net,0);assert.equal(f.e.auto,false);assert.equal(SESSION_TARGET,20);assert.equal(f.e.entryPolicy.sessionTarget,20);
 assert.equal(f.e.state.startedAt,f.e.state.resetAt);assert.equal(f.e.incomeWindowStart,f.e.state.resetAt);assert.equal(f.e.incomeWindowEnd,f.e.state.resetAt);assert.ok(f.e.lastIncome);assert.equal(f.e.state.dayOpenPnl,0);
 assert.equal(f.e.state.archives.at(-1).records,previous.records);assert.equal(f.e.state.records.length,0);assert.equal(f.e.state.goalStopAt,undefined);assert.equal(f.e.state.goalNet,undefined);assert.equal(f.e.sessionCloseEstimate,null);
 assert.equal(f.saved.at(-1).resetAt,f.e.state.resetAt);assert.equal(f.e.tradeReport().netSession,0);assert.equal(f.e.balance,5000);assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('subsequent income sync excludes earlier loss and counts new realized PnL, commissions and funding',async()=>{
 const f=losingSession();await f.e.resetFromBinance();const reset=f.e.state.resetAt,base=f.api.call;f.api.offset+=1000;
 const row=(income,time,incomeType='REALIZED_PNL',asset='USDT')=>({income, time,incomeType,asset});
 f.api.call=async(m,p,q,s)=>{
  if(p!=='/fapi/v1/income')return base(m,p,q,s);
  assert.equal(q.startTime,reset);
  return [row('-39.44',reset-1),row('2',reset+1),row('-.2',reset+1,'COMMISSION'),row('-.1',reset+2,'FUNDING_FEE'),row('-50',q.endTime+1),row('1000',reset,'TRANSFER'),row('900',reset,'REALIZED_PNL','USDC')];
 };
 await f.e.updateIncome();assert.equal(f.e.income.length,3);assert.ok(Math.abs(f.e.sessionNet()-1.7)<1e-9);assert.equal(f.e.incomeWindowStart,reset);
});
test('zero result survives daily sync, saved-state reload and another income refresh',async()=>{
 const f=losingSession(),oldIncome=f.e.income;await f.e.resetFromBinance();const reset=f.e.state.resetAt,base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'?oldIncome:base(m,p,q,s);
 f.e.syncDaily();await f.e.updateIncome();assert.equal(f.e.state.startedAt,reset);assert.equal(f.e.sessionNet(),0);
 const restored=new DemoEngine(f.api,JSON.parse(JSON.stringify(f.saved.at(-1))),()=>{});
 restored.syncDaily();await restored.refresh();await restored.updateIncome();assert.equal(restored.state.startedAt,reset);assert.equal(restored.sessionNet(),0);assert.equal(restored.state.archives.at(-1).records.length,1);assert.equal(restored.auto,false);
});
test('late income response started before reset cannot restore the old negative amount',async()=>{
 const f=losingSession(),oldIncome=f.e.income,base=f.api.call;let release;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'?new Promise(r=>release=r):base(m,p,q,s);
 const stale=f.e.updateIncome();await f.e.resetFromBinance();const reset=f.e.state.resetAt;release(oldIncome);await stale;
 assert.equal(f.e.sessionNet(),0);assert.equal(f.e.incomeWindowStart,reset);assert.equal(f.e.incomeWindowEnd,reset);
});
test('income without a valid transaction time cannot silently enter a new reset window',async()=>{
 const f=losingSession();await f.e.resetFromBinance();const base=f.api.call,at=f.e.lastIncome;
 for(const time of [undefined,NaN,-1,1.5]){
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'?[{income:'-39.44',asset:'USDT',incomeType:'REALIZED_PNL',time}]:base(m,p,q,s);
  await assert.rejects(()=>f.e.updateIncome());assert.equal(f.e.sessionNet(),0);assert.equal(f.e.lastIncome,at);
 }
});
test('failed persistence keeps the previous result and journal instead of claiming a reset',async()=>{
 const f=losingSession(),previous=f.e.state,income=f.e.income;f.e.state.dayOpenPnl=0;f.e.persist=()=>{throw Error('Storage unavailable');};
 await assert.rejects(()=>f.e.resetFromBinance(),/Storage unavailable/);assert.equal(f.e.state,previous);assert.equal(f.e.income,income);assert.equal(f.e.sessionNet(),-39.44);assert.equal(f.e.auto,false);
});
