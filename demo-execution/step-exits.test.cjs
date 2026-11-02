const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoEngine,DemoError,steppedProfitFloor,bollingerSetup}=require('./engine.js');
const {fixture,entryBars,continuationBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function bandBars(side){
 const ms=300000,end=Math.floor(Date.now()/ms)*ms;
 const rows=Array.from({length:30},(_,i)=>{const c=105+.2*Math.sin(i);return [end-(30-i)*ms,c-.1,c+.3,c-.3,c,100,end-(29-i)*ms-1];});
 Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});
 return side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]);
}
async function opened(side='BUY'){
 const f=fixture(),base=f.api.call;f.e.newRules=f.e.bandRules=true;f.signal.side=side;
 f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/commissionRate'?{symbol:q.symbol,takerCommissionRate:'.00001'}:p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:20,notionalCap:1000000,notionalFloor:0}]}:p==='/fapi/v1/klines'?(q.interval==='5m'?bandBars(side):entryBars(side)):base(m,p,q,s);
 f.signal=bollingerSetup(bandBars(side),side,Date.now());await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol));return f;
}
function recoveryCandles(f,{stale=false,weak=false,against=false,beforeEntry=false}={}){
 const r=f.e.owned(symbol),price=Number(f.position.markPrice),side=against?(r.side==='BUY'?'SELL':'BUY'):r.side;
 if(!beforeEntry){r.at-=120000;r.openedAt=r.at;}
 const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>{
  if(p==='/fapi/v1/klines'){
   const rows=continuationBars(side,q.interval==='5m'?300000:60000,Date.now()-(stale?600000:0));
   rows.at(-1)[5]=weak?10:40;
   const delta=price-100;return rows.map(b=>[b[0],b[1]+delta,b[2]+delta,b[3]+delta,b[4]+delta,b[5],b[6]]);
  }return base(m,p,q,s);
 };f.e.candleCache=new Map();
}
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
for(const [peak,floor] of [[0,null],[5,null],[5.00000001,5],[6,5],[8,5],[8.01,8],[11,8],[11.01,11],[20,17],[20.01,20],[101,98],[101.01,101]])test('profit peak '+peak+' arms '+floor,()=>assert.equal(steppedProfitFloor(peak),floor));
for(const side of ['BUY','SELL']){
 test(side+' holds increasing profits and closes only on the armed after-fee floor',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);
  for(const net of [.5,3,5,6,8,9,12,15,18,20]){setTradeNet(f,net);await f.e.reconcile();assert.ok(!r.closedAt,'should hold rising '+net);}
  assert.equal(r.trailPeak,20);assert.equal(r.profitFloor,17);setTradeNet(f,17.2);await f.e.reconcile();assert.ok(!r.closedAt);
  setTradeNet(f,17);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Stepped net profit pullback');assert.equal(f.e.auto,true);assert.equal(closes(f).length,1);
  const booked=f.trades.reduce((n,t)=>n+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(booked-17)<1e-6);
 });
 test(side+' closes at $6 without fresh recovery support',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,-6);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$6 net trade loss');assert.equal(r.lossRecovery.allowed,false);
 });
 test(side+' fresh recovery can hold below $6 but never beyond the $12 exit trigger',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,-7);recoveryCandles(f);await f.e.reconcile();assert.ok(!r.closedAt,r.lossRecovery?.reason);assert.equal(r.lossRecovery.allowed,true);
  setTradeNet(f,-11.9);await f.e.reconcile();assert.ok(!r.closedAt);setTradeNet(f,-12);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$12 net trade loss');assert.equal(f.e.auto,true);
 });
 test(side+' recovery permission is withdrawn when candle support weakens',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,-7);recoveryCandles(f);await f.e.reconcile();assert.ok(!r.closedAt);recoveryCandles(f,{weak:true});await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.lossRecovery.allowed,false);
 });
 test(side+' exchange backup includes opening and closing fees at the $12 target',async()=>{
  const f=await opened(side),r=f.e.owned(symbol),stop=r.exits.find(e=>e.kind==='sl12'&&!e.cancelled),qty=Math.abs(Number(f.position.positionAmt)),price=Number(stop.triggerPrice);
  const net=(price-100)*qty*(side==='BUY'?1:-1)-qty*(100+price)*r.fee;
  assert.ok(net>=-12-1e-7&&net<0);assert.equal(stop.confirmed,true);assert.equal(f.algos.get(stop.id).closePosition,'true');
 });
}
for(const options of [{weak:true},{stale:true},{against:true},{beforeEntry:true}])test('recovery refuses '+JSON.stringify(options),async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-7);recoveryCandles(f,options);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.lossRecovery.allowed,false);
});
test('unavailable recovery data closes at the normal threshold instead of granting extra risk',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-7);const base=f.api.call;f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines')throw new DemoError('unavailable',503);return base(m,p,q,s);};f.e.candleCache=new Map();await f.e.reconcile();assert.ok(r.closedAt);assert.match(r.lossRecovery.reason,/unavailable/i);
});
test('hard loss exit does not wait for candle research',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-13);f.e.scanBars=()=>{throw Error('must not fetch candles at hard cap');};await f.e.reconcile();assert.ok(r.closedAt);assert.equal(closes(f).length,1);
});
test('profitable gross PnL below $5 after fees cannot arm a profit floor',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,4.95);assert.ok(Number(f.position.unRealizedProfit)>5);await f.e.reconcile();assert.equal(r.profitFloor,null);assert.ok(!r.closedAt);
});
test('profit close requotes and holds when net has recovered above the floor',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,9);await f.e.reconcile();assert.equal(r.profitFloor,8);setTradeNet(f,8.5);assert.equal(await f.e.close(symbol,'Stepped net profit pullback'),false);assert.ok(f.position);assert.equal(closes(f).length,0);
});
test('a gap through a previously armed profit floor exits instead of waiting for recovery',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,6);await f.e.reconcile();setTradeNet(f,1);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Stepped net profit pullback');
});
test('net recovery during candle reads prevents closing on the old losing quote',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-7);const base=f.e.supportsLossRecovery.bind(f.e);f.e.supportsLossRecovery=async(...a)=>{await base(...a);setTradeNet(f,-2);return false;};await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(closes(f).length,0);
});
test('a loss crossing $12 during recovery checks closes even when candles supported recovery',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-7);recoveryCandles(f);const base=f.e.supportsLossRecovery.bind(f.e);f.e.supportsLossRecovery=async(...a)=>{const allowed=await base(...a);if(allowed)setTradeNet(f,-12.5);return allowed;};await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$12 net trade loss');
});
test('restarting preserves the highest net and never lowers an armed floor',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,21);await f.e.reconcile();assert.equal(r.profitFloor,20);
 const restored=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});restored.meta=f.e.meta;setTradeNet(f,20.5);await restored.refresh();await restored.reconcile();const again=restored.owned(symbol);assert.equal(again.trailPeak,21);assert.equal(again.profitFloor,20);
 setTradeNet(f,20);await restored.refresh();await restored.reconcile();assert.ok(again.closedAt);
});
test('migration resets obsolete peaks without changing quantity, fees, history or leverage',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.rulesVersion=11;r.exitPolicy='bollinger-targets';r.trailPeak=100;r.profitFloor=95;r.lossReduction={status:'DONE',executedQty:.5};const qty=f.position.positionAmt,leverage=r.leverage;setTradeNet(f,3);
 await f.e.reconcile();assert.equal(r.rulesVersion,12);assert.equal(r.trailPeak,3);assert.equal(r.profitFloor,null);assert.equal(r.previousExitPolicy.trailPeak,100);assert.equal(f.position.positionAmt,qty);assert.equal(r.leverage,leverage);assert.equal(r.lossReduction.status,'DONE');assert.equal(closes(f).length,0);
});
test('manual close bypasses automatic profit and recovery rules',async()=>{
 const f=await opened();setTradeNet(f,-1);await f.e.close(symbol);assert.equal(f.position,null);assert.equal(closes(f).length,1);
});
test('the $100 session stop remains authoritative',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,110);f.e.sessionNet=()=>110;f.e.incomeWindowStart=f.e.state.startedAt;f.e.lastIncome=Date.now();await f.e.enforceSessionGoal();assert.ok(f.e.state.goalStopAt);assert.equal(f.e.auto,false);assert.ok(r.closedAt);
});
test('a cancelled old $6 backup-close intent rechecks the new recovery rule',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.pendingClose='bd1_old6_c';r.closeReason='sl6 threshold reached';f.orders.set(r.pendingClose,{status:'CANCELED',executedQty:'0'});setTradeNet(f,-7);recoveryCandles(f);await f.e.reconcile();assert.ok(f.position);assert.ok(!r.pendingClose);assert.equal(closes(f).length,0);assert.equal(r.lossRecovery.allowed,true);
});
test('an ambiguous profit close is journaled and never blindly submitted again',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,9);await f.e.reconcile();setTradeNet(f,8);f.failClose=true;
 await assert.rejects(()=>f.e.reconcile(),e=>e.uncertain);assert.ok(r.pendingClose);assert.equal(closes(f).length,1);
 await assert.rejects(()=>f.e.reconcile());assert.equal(closes(f).length,1);
});
test('profit checks still close owned positions while Auto entries are manually stopped',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,9);await f.e.reconcile();f.e.pause('Manual Stop');setTradeNet(f,8);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(f.e.auto,false);
});
