'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError,trendContinuationSetup,bollingerSetup,bandEntryCosts,bandEntryLiveCheck,entryConfirmation}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function trendBars(side,ms=60000){
 const rows=entryBars(side),end=Math.floor(Date.now()/ms)*ms;
 rows.forEach((b,i)=>{b[0]=end-(rows.length-i)*ms;b[6]=b[0]+ms-1;});return rows;
}
function setup(side='BUY',band=false){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.e.entryPolicy={...new DemoEngine({offset:0}).entryPolicy,...f.e.entryPolicy,profitExit:'small-net-profit',profitStart:1,profitStep:null,takeProfit:1,minimumNetAtTarget:1,entryDirection:'closed-candle-stable-quotes'};f.signal.side=side;
 const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/klines'?trendBars(side,q.interval==='5m'?300000:60000):p==='/fapi/v1/commissionRate'&&band?{takerCommissionRate:'.00001'}:base(m,p,q,s);
 if(band){
  const rows=trendBars('BUY',300000);rows.forEach(b=>{b[1]=104;b[2]=105.3;b[3]=103.7;b[4]=105;});
  Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});
  f.signal=bollingerSetup(side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]),side,Date.now());
 }else f.signal=trendContinuationSetup(trendBars(side),trendBars(side,300000),side,Date.now());
 assert.ok(f.signal);return f;
}
async function opened(side='BUY',band=false){const f=setup(side,band);await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol),f.e.entryOutcome);return f;}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
test('current defaults select small net exits and retain the $20 session and loss controls',()=>{
 const p=new DemoEngine({offset:0}).entryPolicy;
 assert.equal(p.profitExit,'small-net-profit');assert.equal(p.profitStart,1);assert.equal(p.takeProfit,1);assert.equal(p.profitStep,null);assert.equal(p.minimumNetAtTarget,1);
 assert.equal(p.entryDirection,'closed-candle-stable-quotes');assert.equal(p.sessionTarget,20);assert.equal(p.earlyLossMin,null);assert.equal(p.lossLimit,.5);assert.equal(p.maxLossLimit,1);assert.equal(p.lossExit,'tight-net-stop');assert.equal(p.margin,300);
});
for(const side of ['BUY','SELL']){
 for(const net of [1,2,3])test(side+' closes immediately at $'+net+' total net without a pullback',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);assert.equal(r.rulesVersion,13);assert.equal(r.exitPolicy,'small-net-profit');
  setTradeNet(f,net);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$1 net profit target');assert.equal(closes(f).length,1);assert.equal(closes(f)[0].p.reduceOnly,'true');assert.equal(f.e.auto,true);
  const booked=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(booked-net)<1e-6);assert.ok(r.exits.every(e=>e.cancelled));
 });
 test(side+' holds below $1 even when unrealized gross is above $1',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,.99);assert.ok(Number(f.position.unRealizedProfit)>1);await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(r.netEstimate,.99);assert.equal(closes(f).length,0);assert.equal(r.profitFloor,null);
 });
 test(side+' band entries use the same new net-profit exit',async()=>{
  const f=await opened(side,true),r=f.e.owned(symbol);assert.equal(r.signal.setupType,'bollinger-wr');setTradeNet(f,1);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$1 net profit target');
 });
 test(side+' fresh stable quotes can submit a trend entry exactly once',async()=>{
  const f=setup(side),base=f.api.call;let reads=0;
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'99.99',askPrice:'100.01',bidQty:'1000',askQty:'1000',time:Date.now()-(++reads===1?1000:0)}:base(m,p,q,s);
  await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);assert.equal(Math.abs(r.entryEvidence.liveDirection.bidMove),0);assert.equal(Math.abs(r.entryEvidence.liveDirection.askMove),0);assert.equal(r.entryEvidence.liveDirection.allowStable,true);
  assert.equal(r.entryEvidence.targetCosts.minimumNetAtTarget,1);assert.match(r.entryEvidence.liveDirection.confirmation,/stable or favorable/);
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
 });
 for(const net of [-6.01,-12.01])test(side+' retains loss exit at '+net,async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,net);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,net<=-12?'$12 net trade loss':'$6 net trade loss');assert.equal(closes(f).length,1);
 });
 test(side+' small-profit mode retains the early adverse-move exit around $2 loss',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(side),r=f.e.owned(symbol);r.signal.atr=.2;r.earlyLossQuotes=[];
  for(const net of [-.2,-.8]){t.mock.timers.tick(1100);setTradeNet(f,net);await f.e.reconcile();assert.ok(f.position);}
  t.mock.timers.tick(1100);setTradeNet(f,-2.2);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Early adverse-move exit');assert.equal(closes(f).length,1);
 });
}
test('the final profit recheck prevents an order when the quote falls below $1',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,1.2);const base=f.api.call;let quotes=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++quotes===2){setTradeNet(f,.8);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.equal(closes(f).length,0);assert.equal(r.netEstimate,.8);
 setTradeNet(f,1.1);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(closes(f).length,1);
});
test('a final profit recheck crossing the loss limit still closes under the loss policy',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,1.2);const base=f.api.call;let quotes=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++quotes===2){setTradeNet(f,-12.5);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$12 net trade loss');assert.equal(closes(f).length,1);
});
test('fees are refreshed before dispatch even if the first estimate used cached accounting',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,1.1);f.trades[0].commission=String(Number(f.trades[0].commission)+.3);
 await f.e.reconcile();assert.ok(f.position);assert.equal(closes(f).length,0);assert.equal(r.netEstimate,.8);
});
for(const failure of ['fees','funding','quote'])test(failure+' failure defers a small-profit close and retains backup protection',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,2);const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p===(failure==='fees'?'/fapi/v1/userTrades':failure==='funding'?'/fapi/v1/income':'/fapi/v1/ticker/bookTicker'))throw new DemoError('test unavailable',503);return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.equal(closes(f).length,0);assert.ok(r.estimateError);assert.ok(r.exits.some(e=>e.kind==='sl12'&&e.confirmed&&!e.cancelled));
});
test('funding and previous partial-close results still count toward the $1 trade net',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-3);await f.e.reduceLosingPosition(r);assert.equal(r.lossReduction.status,'DONE');assert.ok(f.trades.some(t=>Number(t.realizedPnl)<0));
 setTradeNet(f,1.2);const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'? [{symbol,incomeType:'FUNDING_FEE',asset:'USDT',income:'-.3',time:Date.now()}]:base(m,p,q,s);
 r.tradeAccounting=null;await f.e.reconcile();assert.ok(f.position);assert.equal(r.netEstimate,.9);assert.ok(r.closingEstimate.realized<0);assert.equal(r.closingEstimate.funding,-.3);
 setTradeNet(f,1.4);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closingEstimate.net,1.1);
});
test('ambiguous small-profit closes are journaled and never blindly duplicated',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,2);f.failClose=true;
 await assert.rejects(()=>f.e.reconcile(),e=>e.uncertain);assert.ok(r.pendingClose);assert.equal(closes(f).length,1);await assert.rejects(()=>f.e.reconcile());assert.equal(closes(f).length,1);
});
test('manual Stop stops entries while owned positions can still close at small profit',async()=>{
 const f=await opened(),r=f.e.owned(symbol);f.e.pause('Manual Stop');setTradeNet(f,1);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(f.e.auto,false);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
});
test('migration and restart preserve size, ownership, history and the $12 backup',async()=>{
 const f=await opened(),r=f.e.owned(symbol),quantity=f.position.positionAmt,leverage=r.leverage,orderId=r.orderId;
 r.rulesVersion=12;r.exitPolicy='stepped-net-trailing';r.profitFloor=8;r.trailPeak=9;setTradeNet(f,.7);
 const e=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});e.entryPolicy={...f.e.entryPolicy};e.meta=f.e.meta;await e.refresh();await e.reconcile();const next=e.owned(symbol);
 assert.equal(next.rulesVersion,13);assert.equal(next.exitPolicy,'small-net-profit');assert.equal(next.previousExitPolicy.profitFloor,8);assert.equal(next.profitFloor,null);assert.equal(next.orderId,orderId);assert.equal(next.leverage,leverage);assert.equal(f.position.positionAmt,quantity);assert.equal(f.trades.length,1);assert.ok(next.exits.some(x=>x.kind==='sl12'&&x.confirmed&&!x.cancelled));
 setTradeNet(f,1);await e.refresh();await e.reconcile();assert.ok(next.closedAt);assert.equal(e.auto,false);
});
test('the $20 account-wide target closes even a losing bot position and stops entries',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-1);f.e.sessionNet=()=>25;f.e.incomeWindowStart=f.e.state.startedAt;f.e.lastIncome=Date.now();await f.e.enforceSessionGoal();
 assert.ok(r.closedAt);assert.equal(r.closeReason,'$20 net session target');assert.ok(f.e.state.goalStopAt);assert.equal(f.e.auto,false);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
});
test('the revised reference cost minimum admits $1–$5 opportunities without relaxing commission limits',()=>{
 const signal={setupType:'trend-continuation',side:'BUY',referenceTarget:100.8};
 assert.ok(bandEntryCosts(signal,100,3,.0005).reason);const eligible=bandEntryCosts(signal,100,3,.0005,1);assert.equal(eligible.reason,null);assert.ok(eligible.netAtTarget>1&&eligible.netAtTarget<5);
 assert.ok(bandEntryCosts(signal,100,1,.0005,1).reason);assert.ok(bandEntryCosts(signal,100,3,.01,1).reason);
});

// Verbatim price/timestamp/candle values from the supplied V1.77 TAKEUSDT report.
test('recorded TAKEUSDT stable quotes no longer fail solely for no two-tick continuation',()=>{
 const before={symbol:'TAKEUSDT',bidPrice:'0.0627800',askPrice:'0.0629400',time:1794665264663};
 const quote={...before,time:1794665267991};
 const momentum={atr:.00013449999999999782,close:.06285,open:.06282,fast:.062786,slow:.063122,body:.4285714285714569,closeStrength:1,previousClose:.06282,threeBarsAgo:.06274,closedAt:1794665219999,side:'BUY',reason:null,signalMinutes:2};
 const options={symbol:'TAKEUSDT',side:'BUY',tick:.00001,now:1794665269453};
 assert.match(bandEntryLiveCheck(before,quote,momentum,options).reason,/Waiting for both/);
 const out=bandEntryLiveCheck(before,quote,momentum,{...options,allowStable:true});assert.equal(out.reason,null);assert.equal(out.comparisonBasis,'quote-midpoint');assert.equal(out.bidMove,0);assert.equal(out.askMove,0);
});
for(const side of ['BUY','SELL']){
 function stableInput(){
  const now=1800000030000,raw=entryBars(side,now),momentum=entryConfirmation(raw,{side,setupType:'bollinger-wr',intervalMs:300000},now);
  const before={symbol,bidPrice:99.99,askPrice:100.01,time:now-1000},quote={...before,time:now};return {before,quote,momentum,options:{symbol,side,tick:.01,now,raw,allowStable:true}};
 }
 for(const kind of ['opposing','widening spread','same timestamp','stale baseline','stale final','future','settings reversal','settings spread','candle reversal','late chase','forming reversal'])test(side+' stable mode rejects '+kind,()=>{
  const f=stableInput(),sign=side==='BUY'?1:-1;
  if(kind==='opposing'){f.quote.bidPrice-=sign*.01;f.quote.askPrice-=sign*.01;}
  if(kind==='widening spread'){if(side==='BUY')f.quote.askPrice+=.01;else f.quote.bidPrice-=.01;}
  if(kind==='same timestamp')f.quote.time=f.before.time;
  if(kind==='stale baseline')f.before.time=f.options.now-10001;
  if(kind==='stale final'){f.before.time=f.options.now-6000;f.quote.time=f.options.now-5001;}
  if(kind==='future')f.quote.time++;
  if(kind==='settings reversal')f.options.checkpoint={...f.quote,bidPrice:99.99+sign*.01,askPrice:100.01+sign*.01,time:f.options.now-500};
  if(kind==='settings spread')f.options.checkpoint={...f.quote,bidPrice:side==='BUY'?99.99:100,askPrice:side==='BUY'?100:100.01,time:f.options.now-500};
  if(kind==='candle reversal')f.momentum.reason='Opposing candle';
  if(kind==='late chase'){f.quote.bidPrice+=sign;f.quote.askPrice+=sign;}
  if(kind==='forming reversal'){const start=f.momentum.closedAt+1,close=100-sign*.02;f.options.raw.push([start,100,100.03,99.97,close,10,start+59999]);}
  assert.ok(bandEntryLiveCheck(f.before,f.quote,f.momentum,f.options).reason,kind);
 });
}
