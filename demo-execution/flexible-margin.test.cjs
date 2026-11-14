'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,trendContinuationSetup}=require('./engine.js');
const {v181Policy,fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
function setup({side='BUY',fee=.0005,scale=1,ceiling=100,available=5000,tiered=false,capacity=1000000,finalWick=0}={}){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.e.entryPolicy=v181Policy();f.signal.side=side;
 if(tiered)Object.assign(f.e.entryPolicy,{marginMode:'leverage-targeted',preferredMargins:[{leverage:100,margin:15},{leverage:50,margin:25}],fallbackMargin:25,leverageMode:'preferred-with-risk-fallback'});
 const bars=ms=>{const rows=entryBars(side,Date.now(),scale),end=Math.floor(Date.now()/ms)*ms;rows.forEach((b,i)=>{b[0]=end-(rows.length-i)*ms;b[6]=b[0]+ms-1;});return rows;};
 let minuteReads=0;const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>{
  if(p==='/fapi/v1/klines'){const rows=bars(q.interval==='5m'?300000:60000);if(q.interval==='1m'&&++minuteReads===2)rows[10][2]+=finalWick;return rows;}
  if(p==='/fapi/v1/commissionRate')return {takerCommissionRate:String(fee)};
  if(p==='/fapi/v1/leverageBracket')return {symbol,brackets:[{initialLeverage:ceiling,notionalCap:1000000,notionalFloor:0}]};
  const out=await base(m,p,q,s);
  if(p==='/fapi/v3/account')out.assets[0].availableBalance=String(available);
  if(m==='POST'&&p==='/fapi/v1/leverage')out.maxNotionalValue=String(capacity);
  return out;
 };
 f.signal=trendContinuationSetup(bars(60000),bars(300000),side,Date.now());assert.ok(f.signal);return f;
}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
async function opened(options){const f=setup(options);await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);return {f,r};}
function riskFits(r){const v=r.entryEvidence;assert.ok(v.estimatedRoundTripFees<=.25+1e-8);assert.ok(v.estimatedImmediateExitNet>=-.25-1e-8);assert.ok(v.estimatedLossAtOneAtr<=1+1e-8);assert.ok(v.targetCosts.netAtTarget>=1);assert.ok(r.exits.some(x=>x.kind==='sl1'&&x.confirmed&&!x.cancelled));}
test('V1.81 defaults use flexible sizing with no requested margin floor and all entry frames',()=>{
 const p=v181Policy();
 assert.equal(p.marginMode,'risk-capped');assert.equal(p.leverageMode,'highest-fee-compatible');assert.equal(p.margin,300);assert.equal(p.maxLeverage,100);assert.equal(p.preferredMargins,undefined);assert.equal(p.fallbackMargin,undefined);
 assert.deepEqual(p.timeframes,[1,2,3,4,5,6,7,8,9,10,15,20,30,60]);assert.deepEqual(p.strategies,['bollinger-wr','trend-continuation']);assert.equal(p.lossLimit,.5);assert.equal(p.maxLossLimit,1);assert.equal(p.takeProfit,1);assert.equal(p.sessionTarget,20);
});
for(const side of ['BUY','SELL']){
 test(side+' submits a valid smaller order where the old $25 floor blocks on funds',async()=>{
  const options={side,ceiling:50,available:20};const old=setup({...options,tiered:true});await old.e.enter(symbol,old.signal);assert.equal(entries(old).length,0);
  const {f,r}=await opened(options);assert.ok(r.estimatedEntryMargin<15);assert.equal(r.requestedEntryMargin,undefined);assert.equal(f.e.auto,true);riskFits(r);
 });
 test(side+' accepts valid orders with less than $15 available',async()=>{
  const {r}=await opened({side,available:5});assert.ok(r.estimatedEntryMargin+r.entryEvidence.estimatedRoundTripFees<=5);riskFits(r);
 });
 test(side+' resizes to exchange capacity instead of requiring the margin tier',async()=>{
  const {r}=await opened({side,fee:.00001,scale:.16,capacity:1000});assert.ok(Number(r.quantity)*100<=1000);assert.ok(r.estimatedEntryMargin<15);riskFits(r);
 });
 for(const net of [-.5,1])test(side+' flexible order still closes at '+net+' net',async()=>{
  const {f,r}=await opened({side});setTradeNet(f,net);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,net<0?'$0.50 net trade loss':'$1 net profit target');
 });
}
for(const [ceiling,expected] of [[150,100],[100,100],[99,99],[80,80],[51,51],[50,50]])test('exchange ceiling '+ceiling+' selects '+expected+'x without tier gaps or exceeding policy',async()=>{
 const {f,r}=await opened({ceiling});assert.equal(r.leverage,expected);assert.ok(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/leverage').every(c=>c.p.leverage<=expected));riskFits(r);
});
test('a moderate final volatility change shrinks a valid order rather than requiring $15 margin',async()=>{
 const options={fee:.00001,scale:.16,finalWick:.2};const old=setup({...options,tiered:true});await old.e.enter(symbol,old.signal);assert.equal(entries(old).length,0);
 const baseline=await opened({fee:.00001,scale:.16}),{r}=await opened(options);assert.ok(Number(r.quantity)<Number(baseline.r.quantity));riskFits(r);
});
test('a severe final volatility change still skips if resized reference net is insufficient',async()=>{
 const f=setup({fee:.00001,scale:.12,finalWick:4});await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Fresh quote: Reference target leaves less than/);
});
test('flexible sizing never rounds up through the risk cap to meet Binance minimums',async()=>{
 const f=setup();for(const filter of f.e.meta.get(symbol).filters)if(['MARKET_LOT_SIZE','LOT_SIZE'].includes(filter.filterType)){filter.stepSize='10';filter.minQty='10';}
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/minimum.*stop budget/);
});
test('manual Stop during flexible sizing prevents dispatch',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/leverage')f.e.pause('Manual Stop');return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,false);
});
test('an uncertain flexible entry is never duplicated and an open position is never topped up',async()=>{
 const f=setup();f.unknownEntry=true;await f.e.enter(symbol,f.signal);const qty=f.position.positionAmt;
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.position.positionAmt,qty);
});
