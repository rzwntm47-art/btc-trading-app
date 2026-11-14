'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError,trendContinuationSetup,bollingerSetup}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function bars(side,ms=60000){const rows=entryBars(side),end=Math.floor(Date.now()/ms)*ms;rows.forEach((b,i)=>{b[0]=end-(rows.length-i)*ms;b[6]=b[0]+ms-1;});return rows;}
function setup(side='BUY',band=false,legacy=false){
 const f=fixture(),prior=f.e.entryPolicy;f.e.newRules=f.e.bandRules=true;f.e.entryPolicy={...new DemoEngine({offset:0}).entryPolicy,marginMode:'risk-capped',leverageMode:'highest-fee-compatible',maxLeverage:150};f.signal.side=side;
 if(legacy)f.e.entryPolicy={...f.e.entryPolicy,...prior,profitExit:'small-net-profit',profitStart:1,profitStep:null,takeProfit:1,minimumNetAtTarget:1,entryDirection:'closed-candle-stable-quotes'};
 const base=f.api.call;f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/klines'?bars(side,q.interval==='5m'?300000:60000):base(m,p,q,s);
 if(band){const rows=bars('BUY',300000);rows.forEach(b=>{b[1]=104;b[2]=105.3;b[3]=103.7;b[4]=105;});Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});f.signal=bollingerSetup(side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]),side,Date.now());}
 else f.signal=trendContinuationSetup(bars(side),bars(side,300000),side,Date.now());
 assert.ok(f.signal);return f;
}
async function opened(side='BUY',band=false,legacy=false){const f=setup(side,band,legacy);await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol),f.e.entryOutcome);return f;}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
test('tight defaults retain entry strategies, $1 profit and the $20 session target',()=>{
 const p=new DemoEngine({offset:0}).entryPolicy;assert.equal(p.lossExit,'tight-net-stop');assert.equal(p.lossLimit,.5);assert.equal(p.maxLossLimit,1);assert.equal(p.earlyLossExit,null);assert.equal(p.marginMode,'risk-capped');assert.equal(p.takeProfit,1);assert.equal(p.sessionTarget,20);assert.deepEqual(p.strategies,['bollinger-wr','trend-continuation']);assert.equal(p.entryDirection,'closed-candle-stable-quotes');
});
for(const side of ['BUY','SELL']){
 for(const band of [false,true])test(side+' '+(band?'band':'trend')+' uses a smaller position that fits fees, spread and volatility',async()=>{
  const f=await opened(side,band),r=f.e.owned(symbol),v=r.entryEvidence;
  assert.equal(entries(f).length,1);assert.equal(r.rulesVersion,14);assert.equal(r.lossLimit,.5);assert.equal(r.maxLossLimit,1);assert.equal(r.lossExit,'tight-net-stop');assert.ok(r.estimatedEntryMargin<300);
  assert.ok(v.estimatedRoundTripFees<=.25);assert.ok(v.estimatedImmediateExitNet>=-.25);assert.ok(v.estimatedLossAtOneAtr<=1);assert.equal(v.targetCosts.minimumNetAtTarget,1);assert.ok(v.targetCosts.netAtTarget>=1);assert.ok(r.netEstimate>-.5);assert.ok(!r.closedAt);
  assert.ok(r.exits.some(e=>e.kind==='sl1'&&e.confirmed&&!e.cancelled));assert.ok(!r.exits.some(e=>['sl6','sl12'].includes(e.kind)));
  setTradeNet(f,1);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$1 net profit target');
 });
 for(const net of [-.49,-.5,-.51,-.9,-1.2])test(side+' handles '+net+' net without a recovery extension',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);f.e.supportsLossRecovery=async()=>assert.fail('Tight stop must not research recovery');f.e.reviewEarlyLoss=async()=>assert.fail('Do not wait for old $2 threshold');
  setTradeNet(f,net);await f.e.reconcile();assert.equal(!!r.closedAt,net<=-.5);assert.equal(closes(f).length,net<=-.5?1:0);if(net<=-.5)assert.equal(r.closeReason,'$0.50 net trade loss');
  assert.equal(f.e.auto,true);
 });
 test(side+' backup stop includes paid opening and expected closing fees',async()=>{
  const f=await opened(side),r=f.e.owned(symbol),stop=r.exits.find(e=>e.kind==='sl1'&&!e.cancelled),qty=Math.abs(Number(f.position.positionAmt)),price=Number(stop.triggerPrice);
  const net=r.tradeAccounting.bookedNet+(price-100)*qty*(side==='BUY'?1:-1)-qty*price*r.fee;
  assert.ok(net>=-1-1e-8&&net<-.5);const order=f.algos.get(stop.id);assert.equal(order.type,'STOP_MARKET');assert.equal(order.closePosition,'true');assert.equal(order.workingType,'MARK_PRICE');
  assert.equal(order.reduceOnly,undefined);assert.equal(order.quantity,undefined);
 });
 test(side+' forced close rechecks a recovered quote instead of using the old loss',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,-.6);const base=f.api.call;let reads=0;
  f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++reads===2){setTradeNet(f,-.4);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
  await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(closes(f).length,0);assert.equal(r.netEstimate,-.4);
 });
 test(side+' final profit recheck switches to the tight stop when the price reverses',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,1.1);const base=f.api.call;let reads=0;
  f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++reads===2){setTradeNet(f,-.55);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
  await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$0.50 net trade loss');assert.equal(closes(f).length,1);
 });
}
test('final loss recheck takes a recovered $1 profit without waiting for another cycle',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-.6);const base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++reads===2){setTradeNet(f,1.2);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$1 net profit target');
});
test('fees and spread never consume the whole new stop at entry',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'99.99',askPrice:'100.01',bidQty:'1000',askQty:'1000',time:Date.now()-(++reads===1?1000:0)}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.ok(r.entryEvidence.estimatedImmediateExitNet>=-.25);assert.ok(r.netEstimate>-.5);assert.ok(r.entryEvidence.estimatedRoundTripFees<.25);
});
for(const extraRange of [1,4])test('final sizing rechecks volatility and net profit with added range '+extraRange,async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines'&&q.interval==='1m'&&++reads===2){const rows=bars('BUY');rows[10][2]+=extraRange;return rows;}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);
 if(extraRange===1){assert.ok(r,f.e.entryOutcome);assert.ok(Number(r.quantity)<1.999);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1);assert.ok(r.entryEvidence.estimatedImmediateExitNet>=-.25);assert.ok(r.entryEvidence.targetCosts.netAtTarget>=1);}
 else{assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/less than \$1/);}
});
for(const kind of ['quantity','notional'])test('Binance minimum '+kind+' cannot force an oversized position',async()=>{
 const f=setup(),filters=f.e.meta.get(symbol).filters;
 if(kind==='quantity')filters.find(x=>x.filterType==='MARKET_LOT_SIZE').minQty='10';else filters.find(x=>x.filterType==='MIN_NOTIONAL').notional='1000';
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/minimum order size does not fit/);assert.equal(f.e.auto,true);
});
test('smaller valid orders can use available margin below $300',async()=>{
 const f=setup(),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v3/account')out.assets[0].availableBalance='10';return out;};
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.ok(r.estimatedEntryMargin+r.entryEvidence.estimatedRoundTripFees<=10);
});
test('fees too large for the reference move still block entries',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.01'}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/commission/i);
});
test('migration replaces the old $12 stop only after the new $1 stop is confirmed',async()=>{
 const f=await opened('BUY',false,true),r=f.e.owned(symbol),old=r.exits.find(x=>x.kind==='sl12'&&!x.cancelled),qty=f.position.positionAmt,leverage=r.leverage;
 setTradeNet(f,-.4);const previousCalls=f.calls.length;f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(r.rulesVersion,14);assert.equal(r.lossLimit,.5);assert.equal(r.lossRecovery,null);assert.equal(f.position.positionAmt,qty);assert.equal(r.leverage,leverage);
 const changes=f.calls.slice(previousCalls),install=changes.findIndex(c=>c.method==='POST'&&c.path==='/fapi/v1/algoOrder'),cancel=changes.findIndex(c=>c.method==='DELETE'&&c.path==='/fapi/v1/algoOrder'&&(c.p.clientAlgoId===old.id||String(c.p.algoId)===String(old.algoId)));
 assert.ok(install>=0&&cancel>install);assert.equal(old.cancelled,true);assert.ok(r.exits.some(x=>x.kind==='sl1'&&x.confirmed&&!x.cancelled));
});
test('existing large positions already below the new stop close on migration without resizing',async()=>{
 const f=await opened('BUY',false,true),r=f.e.owned(symbol),qty=f.position.positionAmt;setTradeNet(f,-2);r.lossRecovery={allowed:true};f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;
 await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$0.50 net trade loss');assert.equal(Number(closes(f).at(-1).p.quantity),Number(qty));assert.equal(r.lossRecovery,null);
});
test('restart loads tight stops for a previous-version position and does not replay entry',async()=>{
 const f=await opened('SELL',false,true),r=f.e.owned(symbol);setTradeNet(f,-.6);
 const e=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});e.meta=f.e.meta;await e.refresh();await e.reconcile();assert.equal(e.active().length,0);assert.equal(e.state.records[0].closeReason,'$0.50 net trade loss');assert.equal(e.auto,false);assert.equal(entries(f).length,1);
});
for(const kind of ['fees','quote'])test(kind+' failure keeps the new exchange backup active',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-.6);r.tradeAccounting=null;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p===(kind==='fees'?'/fapi/v1/userTrades':'/fapi/v1/ticker/bookTicker'))throw new DemoError('unavailable',503);return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.ok(r.estimateError);assert.ok(r.exits.some(x=>x.kind==='sl1'&&x.confirmed&&!x.cancelled));assert.equal(closes(f).length,0);
});
test('missing ledger during migration still replaces a stale $12 backup',async()=>{
 const f=await opened('BUY',false,true),r=f.e.owned(symbol);setTradeNet(f,-.4);f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades')throw new DemoError('unavailable',503);return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.ok(r.exits.some(x=>x.kind==='sl1'&&x.confirmed&&!x.cancelled));assert.ok(!r.exits.some(x=>x.kind==='sl12'&&!x.cancelled));
});
test('unconfirmed tighter protection closes the position instead of retaining wider loss risk',async()=>{
 const f=await opened('BUY',false,true),r=f.e.owned(symbol);setTradeNet(f,-.4);f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;f.failProtection=true;
 await assert.rejects(()=>f.e.reconcile(),e=>e.code===-1111);assert.ok(r.closedAt);assert.equal(r.closeReason,'Loss protection failure');assert.equal(closes(f).length,1);
});
test('an ambiguous tight-stop close is journaled and not blindly duplicated',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-.55);f.failClose=true;
 await assert.rejects(()=>f.e.reconcile(),e=>e.uncertain);assert.ok(r.pendingClose);assert.equal(closes(f).length,1);await assert.rejects(()=>f.e.reconcile());assert.equal(closes(f).length,1);
});
test('cancelled prior recovery close is reconsidered under the tighter stop',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.pendingClose='bd1_old_c';r.closeReason='Adaptive net loss';f.orders.set(r.pendingClose,{status:'CANCELED',executedQty:'0'});setTradeNet(f,-.7);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$0.50 net trade loss');assert.equal(closes(f).length,1);
});
test('manual Stop still permits the tighter loss exit and does not allow a new entry',async()=>{
 const f=await opened(),r=f.e.owned(symbol);f.e.pause('Manual Stop');setTradeNet(f,-.5);await f.e.reconcile();assert.ok(r.closedAt);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.auto,false);
});
test('the $20 session target still closes bot positions and latches entry stop',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,.3);f.e.sessionNet=()=>21;f.e.incomeWindowStart=f.e.state.startedAt;f.e.lastIncome=Date.now();await f.e.enforceSessionGoal();assert.ok(r.closedAt);assert.equal(r.closeReason,'$20 net session target');assert.ok(f.e.state.goalStopAt);assert.equal(f.e.auto,false);
});
