'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError,trendContinuationSetup}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function setup({side='BUY',fee=.00001,scale=.12,ceiling=100}={}){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;f.signal.side=side;
 const bars=ms=>{const rows=entryBars(side,Date.now(),scale),end=Math.floor(Date.now()/ms)*ms;rows.forEach((b,i)=>{b[0]=end-(rows.length-i)*ms;b[6]=b[0]+ms-1;});return rows;};
 const base=f.api.call;f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/klines'?bars(q.interval==='5m'?300000:60000):p==='/fapi/v1/commissionRate'?{takerCommissionRate:String(fee)}:p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:ceiling,notionalCap:1000000,notionalFloor:0}]}:base(m,p,q,s);
 f.signal=trendContinuationSetup(bars(60000),bars(300000),side,Date.now());assert.ok(f.signal);return f;
}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
const leveragePosts=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/leverage');
test('default policy requests the two agreed margin tiers and keeps the net loss and session targets',()=>{
 const p=new DemoEngine({offset:0}).entryPolicy;assert.deepEqual(p.preferredMargins,[{leverage:100,margin:15},{leverage:50,margin:25}]);assert.equal(p.fallbackMargin,25);assert.equal(p.maxLeverage,100);assert.equal(p.marginMode,'leverage-targeted');assert.equal(p.lossLimit,.5);assert.equal(p.maxLossLimit,1);assert.equal(p.takeProfit,1);assert.equal(p.sessionTarget,20);
});
for(const side of ['BUY','SELL']){
 for(const [ceiling,expectedLeverage,margin] of [[150,100,15],[100,100,15],[75,50,25],[50,50,25]])test(side+' uses $'+margin+' at '+expectedLeverage+'x under ceiling '+ceiling+' when costs fit',async()=>{
  const f=setup({side,ceiling});await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);assert.equal(r.leverage,expectedLeverage);assert.ok(Math.abs(r.estimatedEntryMargin-margin)<1e-8);assert.equal(r.requestedEntryMargin,margin);
  assert.ok(r.entryEvidence.estimatedRoundTripFees<=.25);assert.ok(r.entryEvidence.estimatedImmediateExitNet>=-.25);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1);assert.ok(r.entryEvidence.targetCosts.netAtTarget>=1);assert.equal(r.lossLimit,.5);assert.ok(r.exits.some(x=>x.kind==='sl1'&&x.confirmed&&!x.cancelled));
  const report=f.e.tradeReport().botRecords.at(-1);assert.equal(report.requestedEntryMargin,margin);
 });
 test(side+' uses $25 with lower leverage when 50x/100x fees exceed the stop budget',async()=>{
  const f=setup({side,fee:.0005,scale:1});await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.leverage,7);assert.equal(r.estimatedEntryMargin,25);assert.equal(r.requestedEntryMargin,25);assert.equal(entries(f).length,1);
  assert.ok(r.entryEvidence.estimatedRoundTripFees<=.25);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1);assert.ok(leveragePosts(f).every(c=>c.p.leverage<50));
 });
 for(const net of [-.5,1])test(side+' new margin keeps '+net+' net exit behavior',async()=>{
  const f=setup({side});await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r);setTradeNet(f,net);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,net<0?'$0.50 net trade loss':'$1 net profit target');
 });
}
test('high-tier rejection falls directly from 100x to the requested 50x/$25 tier',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/leverage'&&q.leverage===100){f.calls.push({method:m,path:p,p:q});throw new DemoError('unsupported leverage',-4028);}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.leverage,50);assert.equal(r.estimatedEntryMargin,25);assert.ok(leveragePosts(f).every(c=>[100,50].includes(c.p.leverage)));
});
test('capacity fallback finds lower leverage while preserving the $25 margin',async()=>{
 const f=setup({scale:.16}),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/leverage')out.maxNotionalValue='1000';return out;};
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.leverage,40);assert.equal(r.estimatedEntryMargin,25);assert.equal(r.requestedEntryMargin,25);assert.ok(Number(r.quantity)*100<=1000);
 assert.ok(leveragePosts(f).every(c=>c.p.leverage<=50||c.p.leverage===100));
});
test('insufficient funds skip instead of silently reducing the requested margin',async()=>{
 const f=setup({ceiling:50}),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v3/account')out.assets[0].availableBalance='20';return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.equal(f.e.state.records.length,0);
});
test('fallback to $25 is refused if only the $15 high tier was affordable',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/leverage'&&q.leverage===100)throw new DemoError('unsupported',-4028);const out=await base(m,p,q,s);if(p==='/fapi/v3/account')out.assets[0].availableBalance='20';return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.state.records.length,0);
});
test('a new wider spread at final dispatch cannot shrink margin or bypass the cost budget',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/ticker/bookTicker'&&++reads>=3){out.bidPrice='99.8';out.askPrice='100.2';}return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);
});
test('a final volatility jump skips rather than sending an oversized-risk or smaller-margin order',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/klines'&&q.interval==='1m'&&++reads===2)out[10][2]+=4;return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/exposure exceeds/);
});
test('coarse Binance quantity steps round up to the margin only when all risk limits fit',async()=>{
 const f=setup({fee:.000001});for(const filter of f.e.meta.get(symbol).filters)if(['MARKET_LOT_SIZE','LOT_SIZE'].includes(filter.filterType))filter.stepSize='.7';
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.ok(r.estimatedEntryMargin>=r.requestedEntryMargin);assert.ok(r.estimatedEntryMargin<r.requestedEntryMargin+.7);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1);
});
test('Stop during configuration still prevents an order at the higher margin',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/leverage')f.e.pause('Manual Stop');return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,false);
});
test('unknown entry status at the requested margin is never blindly duplicated',async()=>{
 const f=setup();f.unknownEntry=true;await f.e.enter(symbol,f.signal);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.state.records.length,1);
});
test('already-open positions are never topped up when the margin policy changes',async()=>{
 const f=setup({fee:.0005,scale:1});f.e.entryPolicy.marginMode='risk-capped';await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol),qty=f.position.positionAmt,leverage=r.leverage;
 assert.ok(r);f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;await f.e.reconcile();await f.e.enter(symbol,f.signal);assert.equal(f.position.positionAmt,qty);assert.equal(r.leverage,leverage);assert.equal(entries(f).length,1);
});
