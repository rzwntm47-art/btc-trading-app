'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError,minuteMomentumSetup,flexibleProfitFloor,entryConfirmation}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol,v181Policy}=require('./test-fixture.cjs');
function setup(side='BUY',{forming=false}={}){
 const f=fixture();f.e.newRules=f.e.bandRules=f.e.tradingReady=true;f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;f.signal.side=side;
 f.candleReads=[];const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>{
  if(p==='/fapi/v1/klines'){
   f.candleReads.push(q.interval);assert.equal(q.interval,'1m','A fast entry must not request 5m confirmation');
   const rows=entryBars(side);
   if(forming){const start=rows.at(-1)[6]+1,sign=side==='BUY'?1:-1;rows.push([start,100-sign*.01,100.02,99.98,100,20,start+59999]);}
   return rows;
  }
  return base(m,p,q,s);
 };
 f.signal=minuteMomentumSetup(entryBars(side),side,Date.now());assert.ok(f.signal);return f;
}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
async function opened(side='BUY',options){const f=setup(side,options);await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol),f.e.entryOutcome);return f;}
test('new defaults use a $1 net trigger, $1.50 backup, uncapped profit trail and booked $20 target',()=>{
 const p=new DemoEngine({offset:0}).entryPolicy;
 assert.equal(p.lossLimit,1);assert.equal(p.maxLossLimit,1.5);assert.equal(p.profitExit,'flexible-net-trailing');assert.equal(p.profitStart,1);assert.equal(p.takeProfit,null);assert.equal(p.profitTrailMin,.5);assert.equal(p.profitTrailFraction,.1);
 assert.equal(p.sessionTarget,20);assert.equal(p.sessionExit,'trail-open-positions');assert.equal(p.sessionTargetBasis,'booked-net');assert.equal(p.reentryCooldownMs,30000);assert.equal(p.marginMode,'risk-capped');assert.equal(p.margin,300);assert.equal(p.maxLeverage,100);assert.deepEqual(p.timeframes,[1,2,3,4,5,6,7,8,9,10,15,20,30,60]);
});
test('profit trail arms at $1 and scales above $20 without a ceiling',()=>{
 for(const [peak,floor] of [[0,null],[.99,null],[1,.5],[2,1.5],[3,2.5],[5,4.5],[12,10.8],[16,14.4],[20,18],[25,22.5],[100,90]])assert.equal(flexibleProfitFloor(peak),floor);
 assert.equal(flexibleProfitFloor(NaN),null);assert.equal(flexibleProfitFloor(Infinity),null);
});
for(const side of ['BUY','SELL']){
 test(side+' scans and submits from 1m data alone even against the 24h mover direction',async()=>{
  const f=setup(side),mover={side:side==='BUY'?'SELL':'BUY',change:side==='BUY'?-10:10};
  const out=await f.e.scanCandidate(symbol,mover,f.e.stopEpoch);assert.equal(out.signal.setupType,'minute-momentum');assert.equal(out.signal.side,side);assert.equal(out.checks.length,1);
  await f.e.enter(symbol,out.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);assert.ok(f.candleReads.every(x=>x==='1m'));
  assert.equal(r.rulesVersion,15);assert.equal(r.lossLimit,1);assert.equal(r.maxLossLimit,1.5);assert.equal(r.takeProfit,null);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1.5);assert.ok(r.entryEvidence.estimatedRoundTripFees<=.5);assert.equal(f.e.exitPollMs(),1000);
 });
 test(side+' may submit while the current 1m candle is still forming',async()=>{
  const f=await opened(side,{forming:true});assert.equal(entries(f).length,1);assert.ok(f.e.owned(symbol).entryEvidence.liveDirection.forming.end>=Date.now());
 });
 for(const net of [-.99,-1,-1.2,-1.5])test(side+' net loss '+net+' respects the $1 trigger including fees',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,net);await f.e.reconcile();assert.equal(!!r.closedAt,net<=-1);assert.equal(closes(f).length,net<=-1?1:0);if(net<=-1)assert.equal(r.closeReason,'$1 net trade loss');
 });
 test(side+' holds rising profits through $20 and closes at the trailing pullback',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);
  for(const net of [1,2,3,12,20,25]){setTradeNet(f,net);await f.e.reconcile();assert.ok(!r.closedAt,'Must hold rising net '+net);assert.equal(closes(f).length,0);}
  assert.equal(r.trailPeak,25);assert.equal(r.profitFloor,22.5);setTradeNet(f,22.5);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Net profit trailing pullback');assert.equal(closes(f).length,1);
 });
 test(side+' exits a gap below the profit floor instead of waiting to recover',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,20);await f.e.reconcile();setTradeNet(f,16);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Net profit trailing pullback');
 });
 test(side+' backup trigger accounts for paid entry and expected closing commission',async()=>{
  const f=await opened(side),r=f.e.owned(symbol),stop=r.exits.find(e=>e.kind==='sl1p5'&&e.confirmed&&!e.cancelled),qty=Math.abs(Number(f.position.positionAmt)),price=Number(stop.triggerPrice);
  const net=r.tradeAccounting.bookedNet+(price-100)*qty*(side==='BUY'?1:-1)-qty*price*r.fee;
  assert.ok(net>=-1.5-1e-8&&net<-1);assert.equal(f.algos.get(stop.id).type,'STOP_MARKET');assert.equal(f.algos.get(stop.id).closePosition,'true');
 });
}
test('the first $1 peak can close on its $0.50 pullback',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,1);await f.e.reconcile();assert.ok(!r.closedAt);setTradeNet(f,.5);await f.e.reconcile();assert.ok(r.closedAt);
});
test('fresh reversal or stale 1m evidence still prevents an entry',async()=>{
 const f=setup(),now=Date.now();assert.ok(entryConfirmation(entryBars('SELL',now),f.signal,now).reason);assert.equal(minuteMomentumSetup(entryBars('BUY',now-120000),'BUY',now),null);
 const base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/ticker/bookTicker')return {...out,bidPrice:'99.6',askPrice:'99.6'};return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);
});
test('Stop during fast scan cancels the candidate before entry',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/klines')f.e.pause('Manual Stop');return out;};
 await assert.rejects(()=>f.e.scanCandidate(symbol,{side:'BUY',change:10},f.e.stopEpoch),/cancelled/);assert.equal(entries(f).length,0);
});
test('a filtered fast candidate does not starve the older timeframe strategies',async()=>{
 const f=setup(),base=f.api.call;let noFunds=true;
 f.api.call=async(m,p,q={},s)=>{
  if(p==='/fapi/v1/klines'&&q.interval==='5m'){const rows=entryBars('BUY'),end=Math.floor(Date.now()/300000)*300000;rows.forEach((b,i)=>{b[0]=end-(rows.length-i)*300000;b[6]=b[0]+299999;});return rows;}
  const out=await base(m,p,q,s);if(noFunds&&p==='/fapi/v3/account')out.assets[0].availableBalance='0';return out;
 };
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.entryResult.kind,'app-filter');noFunds=false;
 const out=await f.e.scanCandidate(symbol,{side:'BUY',change:10},f.e.stopEpoch);assert.equal(out.checks.filter(c=>c.setupType==='bollinger-wr').length,14);assert.equal(out.signal.setupType,'trend-continuation');
 f.e.fastEntryFiltered.set(symbol,f.signal.close-60000);const fresh=await f.e.scanCandidate(symbol,{side:'BUY',change:10},f.e.stopEpoch);assert.equal(fresh.signal.setupType,'minute-momentum');
});
test('30-second re-entry cooldown permits a fresh candle after close but never replays a filled candle',async()=>{
 const f=setup();f.e.state.records.push({id:'bd1_old',symbol,side:'BUY',entryStatus:'FILLED',at:Date.now()-120000,closedAt:Date.now()-31000,signalClose:f.signal.close-60000,exits:[]});
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
 const blocked=setup();blocked.e.state.records.push({...f.e.state.records[0],closedAt:Date.now()-5000});await blocked.e.enter(symbol,blocked.signal);assert.equal(entries(blocked).length,0);assert.match(blocked.e.entryOutcome,/30 seconds/);
 const replay=setup();replay.e.state.records.push({...f.e.state.records[0],signalClose:replay.signal.close});await replay.e.enter(symbol,replay.signal);assert.equal(entries(replay).length,0);
});
test('unrealized $25 does not complete the booked $20 session goal or close the winner',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,25);await f.e.reconcile();f.e.lastIncome=Date.now();f.e.income=[];
 assert.equal(await f.e.enforceSessionGoal(),false);assert.equal(f.e.auto,true);assert.equal(f.e.state.goalStopAt,undefined);assert.ok(!r.closedAt);assert.equal(closes(f).length,0);
});
test('booked $20 pauses entries while open winners retain trailing exits and manual Stop still permits management',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,25);await f.e.reconcile();f.e.lastIncome=Date.now();f.e.income=[{income:'20'}];
 assert.equal(await f.e.enforceSessionGoal(),true);assert.equal(f.e.auto,false);assert.ok(f.e.state.goalStopAt);assert.ok(!r.closedAt);assert.equal(r.profitFloor,22.5);assert.equal(closes(f).length,0);
 f.e.income=[{income:'18'}];await f.e.enforceSessionGoal();assert.equal(f.e.auto,false);setTradeNet(f,22.5);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(closes(f).length,1);
});
test('goal handling cancels an unfinished entry without force-closing its protected partial fill',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.entryStatus='PARTIALLY_FILLED';f.orders.get(r.id).status='PARTIALLY_FILLED';f.e.income=[{income:'20'}];f.e.lastIncome=Date.now();
 await f.e.enforceSessionGoal();assert.ok(f.calls.some(c=>c.method==='DELETE'&&c.path==='/fapi/v1/order'&&c.p.origClientOrderId===r.id));assert.equal(r.entryStatus,'CANCELED');assert.ok(!r.closedAt);assert.equal(closes(f).length,0);
});
test('restart preserves the peak and does not top up or replay an existing trade',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,20);await f.e.reconcile();const qty=f.position.positionAmt;
 const e=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});e.meta=f.e.meta;await e.refresh();await e.reconcile();const saved=e.owned(symbol);assert.equal(saved.trailPeak,20);assert.equal(saved.profitFloor,18);assert.equal(f.position.positionAmt,qty);assert.equal(entries(f).length,1);
});
test('old small-profit positions migrate once and replace protection before cancelling the old stop',async()=>{
 const f=setup();f.e.entryPolicy=v181Policy();await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol),old=r.exits.find(e=>e.kind==='sl1'&&!e.cancelled),qty=f.position.positionAmt,leverage=r.leverage;
 f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;const before=f.calls.length;setTradeNet(f,.2);await f.e.reconcile();
 assert.equal(r.rulesVersion,15);assert.equal(r.lossLimit,1);assert.equal(r.maxLossLimit,1.5);assert.equal(r.exitPolicy,'flexible-net-trailing');assert.equal(f.position.positionAmt,qty);assert.equal(r.leverage,leverage);
 const calls=f.calls.slice(before),post=calls.findIndex(c=>c.method==='POST'&&c.path==='/fapi/v1/algoOrder'),cancel=calls.findIndex(c=>c.method==='DELETE'&&c.path==='/fapi/v1/algoOrder'&&String(c.p.algoId)===String(old.algoId));assert.ok(post>=0&&cancel>post);assert.ok(old.cancelled);
});
test('fresh quote recovery above the floor cancels an automatic pullback close',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,20);await f.e.reconcile();setTradeNet(f,18);const base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++reads===2){setTradeNet(f,19);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(r.profitFloor,18);assert.equal(closes(f).length,0);
});
for(const path of ['/fapi/v1/userTrades','/fapi/v1/ticker/bookTicker'])test(path+' failure leaves exchange backup in place',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.tradeAccounting=null;const base=f.api.call;f.api.call=async(m,p,q,s)=>{if(p===path)throw new DemoError('temporary read failure',503);return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(!r.closedAt);assert.ok(r.exits.some(e=>e.kind==='sl1p5'&&e.confirmed&&!e.cancelled));
});
test('unknown fast entry and unknown trailing close are never blindly duplicated',async()=>{
 const f=setup();f.unknownEntry=true;await f.e.enter(symbol,f.signal);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
 f.unknownEntry=false;await f.e.reconcile();const r=f.e.owned(symbol);setTradeNet(f,3);await f.e.reconcile();setTradeNet(f,2.5);f.failClose=true;await assert.rejects(()=>f.e.reconcile(),/Order result unknown/);assert.ok(r.pendingClose);const count=closes(f).length;
 await assert.rejects(()=>f.e.reconcile());assert.equal(closes(f).length,count);
});
