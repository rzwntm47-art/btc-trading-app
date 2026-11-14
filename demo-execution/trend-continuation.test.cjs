'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {trendContinuationSetup,bollingerSetup,entryConfirmation,selectEntryCandidate,bandEntryCosts,BAND_TIMEFRAMES}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function trendBars(side='BUY',at=Date.now(),ms=60000){
 const rows=entryBars(side,at),end=Math.floor(at/ms)*ms;
 for(let i=0;i<rows.length;i++){rows[i][0]=end-(rows.length-i)*ms;rows[i][6]=rows[i][0]+ms-1;}
 return rows;
}
function setup(side='BUY'){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.signal.side=side;const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/klines'?trendBars(side,Date.now(),q.interval==='5m'?300000:60000):base(m,p,q,s);
 f.signal=trendContinuationSetup(trendBars(side),trendBars(side,Date.now(),300000),side,Date.now());assert.ok(f.signal);return f;
}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
for(const side of ['BUY','SELL']){
 test(side+' trend can qualify with no Bollinger rebound',()=>{
  const at=Date.now(),minute=trendBars(side,at),five=trendBars(side,at,300000),s=trendContinuationSetup(minute,five,side,at);
  assert.equal(bollingerSetup(minute,side,at,()=>{},60000),null);assert.equal(s.setupType,'trend-continuation');assert.equal(s.side,side);assert.equal(s.intervalMs,60000);
  assert.equal(entryConfirmation(minute,s,at,five).reason,null);assert.equal(s.trendEvidence.fiveMinute.side,side);assert.equal(s.referenceAtr,2);
 });
 test(side+' scanner adds trend without losing any Bollinger timeframe or duplicating native reads',async()=>{
  const f=setup(side),out=await f.e.scanCandidate(symbol,{side,change:side==='BUY'?12:-12},f.e.stopEpoch);
  assert.equal(out.signal.setupType,'trend-continuation');assert.equal(out.signal.marketSource.type,side==='BUY'?'gainer':'loser');
  assert.deepEqual(out.checks.filter(c=>c.setupType==='bollinger-wr').map(c=>c.minutes),BAND_TIMEFRAMES);
  assert.equal(out.checks.at(-1).setupType,'trend-continuation');assert.equal((await f.e.scanCandidate(symbol,null,f.e.stopEpoch)).signal,null);
 });
 test(side+' trend entry submits once with volatility-sized leverage and existing protection',async()=>{
  const f=setup(side);await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);
  assert.equal(r.signal.setupType,'trend-continuation');assert.equal(r.entryEvidence.setupType,'trend-continuation');assert.equal(r.entryEvidence.liveDirection.reason,null);
  assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=6);assert.ok(r.entryEvidence.targetCosts.netAtTarget>=5);assert.ok(r.leverage<10);assert.ok(Math.abs(r.estimatedEntryMargin-300)<.01);
  assert.equal(r.bandTargets,undefined);assert.equal(r.trendTargets.referenceTarget,f.signal.referenceTarget);assert.equal(r.lossLimit,6);assert.equal(r.maxLossLimit,12);assert.equal(r.exitPolicy,'stepped-net-trailing');
  assert.ok(r.exits.some(e=>e.kind==='sl12'&&e.confirmed&&!e.cancelled));assert.equal(f.e.tradeReport().botRecords[0].setupType,'trend-continuation');
 });
 test(side+' final five-minute reversal blocks a previously qualifying trend entry',async()=>{
  const f=setup(side),base=f.api.call;let reads=0;
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'&&q.interval==='5m'&&++reads===2?trendBars(side==='BUY'?'SELL':'BUY',Date.now(),300000):base(m,p,q,s);
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.state.records.length,0);assert.match(f.e.entryOutcome,/Final direction check/);assert.equal(f.e.auto,true);
 });
 test(side+' trend entry still rejects flat live quotes',async()=>{
  const f=setup(side),base=f.api.call;
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'100',askPrice:'100',bidQty:'1000',askQty:'1000',time:Date.now()}:base(m,p,q,s);
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Waiting for/);
 });
 test(side+' trend uses the normal loss exit and after-fee profit pullback',async()=>{
  const f=setup(side);await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r);setTradeNet(f,-6.01);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$6 net trade loss');assert.equal(f.e.auto,true);
  const g=setup(side);await g.e.enter(symbol,g.signal);const winner=g.e.owned(symbol);setTradeNet(g,6);await g.e.reconcile();assert.equal(winner.profitFloor,5);setTradeNet(g,4.9);await g.e.reconcile();assert.ok(winner.closedAt);assert.equal(winner.closeReason,'Stepped net profit pullback');
 });
}
test('trend refuses opposing rankings, stale bars, flat candles, low volume and late spikes',()=>{
 const at=Date.now(),minute=trendBars('BUY',at),five=trendBars('BUY',at,300000);
 assert.equal(trendContinuationSetup(minute,five,'SELL',at),null);assert.equal(trendContinuationSetup(minute,five,'BUY',at+400000),null);
 for(const mutate of [r=>{r.at(-1)[1]=r.at(-1)[4];},r=>{r.at(-1)[5]=1;},r=>{r.at(-1)[2]+=10;}]){const rows=structuredClone(minute);mutate(rows);assert.equal(trendContinuationSetup(rows,five,'BUY',at),null);}
 const bad=structuredClone(five);bad[10][0]++;assert.throws(()=>trendContinuationSetup(minute,bad,'BUY',at),/candle/i);
});
test('trend reference economics remain explicit and never turn a cost estimate into a forecast',()=>{
 const f=setup(),costs=bandEntryCosts(f.signal,100,9,.0005);assert.ok(costs.netAtTarget>=5);assert.equal(costs.reason,null);
 assert.ok(bandEntryCosts(f.signal,100,1,.0005).reason);assert.ok(bandEntryCosts(f.signal,100,9,.01).reason);assert.match(f.signal.referenceNote,/not a profit forecast/);
});
test('trend remains selectable after fourteen band candidates fail their price zones',()=>{
 const f=setup(),at=Date.now(),bands=BAND_TIMEFRAMES.map(m=>({...f.signal,setupType:'bollinger-wr',intervalMs:m*60000,close:Math.floor(at/(m*60000))*m*60000-1,bands:{lower:98,middle:99,upper:101}}));
 const result=selectEntryCandidate({...bands[0],alternatives:[...bands.slice(1),f.signal]},{price:100,fee:.0005,now:at,intervals:BAND_TIMEFRAMES,maxCandidates:15});assert.equal(result.signal.setupType,'trend-continuation');assert.equal(result.checks.length,15);
});
test('manual Stop during the trend recheck prevents dispatch',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(p==='/fapi/v1/klines'&&q.interval==='5m'&&++reads===2)f.e.pause('Manual Stop');return result;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,false);
});
test('a latched $20 session prevents any new trend entry',async()=>{
 const f=setup();f.e.state.goalStopAt=Date.now();await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.calls.length,0);
});
test('insufficient free margin and disproportionate fees skip trend entries',async()=>{
 for(const kind of ['margin','fees']){const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(kind==='margin'&&p==='/fapi/v3/account')result.assets[0].availableBalance='299';return kind==='fees'&&p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.01'}:result;};await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);}
});
test('a trend position reaching the net $20 session target closes and locks new entries',async()=>{
 const f=setup();await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r);setTradeNet(f,21);await f.e.refresh();await f.e.updateIncome();
 assert.equal(await f.e.enforceSessionGoal(),true);assert.ok(r.closedAt);assert.equal(f.position,null);assert.equal(f.e.auto,false);assert.ok(f.e.state.goalStopAt);assert.equal(r.closeReason,'$20 net session target');
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
});
test('repeated trend checks cannot duplicate an existing entry',async()=>{
 const f=setup();await f.e.enter(symbol,f.signal);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.state.records.length,1);
});
test('unavailable final trend confirmation defers entry without stopping Auto',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines'&&q.interval==='5m'&&++reads===2)throw Error('5m unavailable');return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.entryResult.kind,'data-unavailable');assert.equal(f.e.auto,true);
});
test('a failed optional trend read does not suppress an independently valid band entry',async()=>{
 const f=setup(),trend=f.signal,base=f.api.call;
 const band={...trend,setupType:'bollinger-wr',intervalMs:300000,close:Math.floor(Date.now()/300000)*300000-1,bands:{lower:95,middle:104,upper:110,outerTarget:109},alternatives:[trend]};
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines'&&q.interval==='5m')throw Error('Optional trend data unavailable');return base(m,p,q,s);};
 await f.e.enter(symbol,band);assert.equal(entries(f).length,1);assert.equal(f.e.owned(symbol).signal.setupType,'bollinger-wr');
});
test('increased volatility at the final quote cancels a trend entry that no longer fits $6',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(p==='/fapi/v1/klines'&&q.interval==='1m'&&++reads===2)for(const row of result){row[2]+=.1;row[3]-=.1;}return result;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/Fresh trend exposure exceeds/);assert.equal(f.e.auto,true);
});
