'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,minuteMomentumSetup}=require('./engine.js');
const {fixture,entryBars,symbol}=require('./test-fixture.cjs');
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
function setup({side='BUY',strict=false,scale=1,shape='normal',fee=.0005,capacity=1000000,quotes='normal'}={}){
 // V1.83 signal regressions use its original size floor; the $150 patch has a separate suite.
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.e.entryPolicy={...new DemoEngine({offset:0}).entryPolicy,minimumPositionNotional:0};f.signal.side=side;
 if(strict)Object.assign(f.e.entryPolicy,{entryFilters:'full-confirmation',entryDirection:'closed-candle-stable-quotes',maxCommissionShare:.25,minimumNetAtTarget:1});
 const rows=()=>{
  const r=entryBars(side,Date.now(),scale),last=r.at(-1),sign=side==='BUY'?1:-1;
  if(shape==='small-body'){last[1]=100-sign*.01;last[2]=100.5;last[3]=99.5;last[5]=2;}
  if(shape==='opposing-averages'){
   for(let i=0;i<r.length-1;i++){const close=100+sign*(r.length-i)*.15;r[i][1]=close+sign*.1;r[i][2]=Math.max(close,r[i][1])+.02;r[i][3]=Math.min(close,r[i][1])-.02;r[i][4]=close;}
   last[1]=100-sign*.1;last[2]=100.15;last[3]=99.85;
  }
  return r;
 };
 let quoteReads=0,minuteReads=0;const base=f.api.call;
 f.api.call=async(m,p,q={},signed)=>{
  if(p==='/fapi/v1/klines'){assert.equal(q.interval,'1m');minuteReads++;return rows();}
  if(p==='/fapi/v1/commissionRate')return {takerCommissionRate:String(fee)};
  const out=await base(m,p,q,signed);
  if(m==='POST'&&p==='/fapi/v1/leverage')out.maxNotionalValue=String(capacity);
  if(p==='/fapi/v1/ticker/bookTicker'){
   quoteReads++;const sign=side==='BUY'?1:-1;
   if(quotes==='pullback'&&quoteReads>=2){const price=100+sign*(quoteReads===2?.02:-.01);out.bidPrice=out.askPrice=String(price);}
   if(quotes==='spread'&&quoteReads>=3){out.bidPrice='99.99';out.askPrice='100.01';}
   if(quotes==='extension'&&quoteReads>=2){out.bidPrice=out.askPrice=String(100+sign);}
   if(quotes==='reversal'&&quoteReads>=2){out.bidPrice=out.askPrice=String(100-sign*.4);}
   if(quotes==='stale'&&quoteReads>=3)out.time=Date.now()-10000;
   if(quotes==='unchanged-time')out.time=Date.now()-1000;
  }
  return out;
 };
 f.signal=minuteMomentumSetup(rows(),side,Date.now(),()=>{},{directionOnly:true});assert.ok(f.signal);f.rows=rows;return f;
}
async function run(options){const f=setup(options);await f.e.enter(symbol,f.signal);return f;}
function protectedEntry(f){
 const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);assert.equal(r.lossLimit,1);assert.equal(r.maxLossLimit,1.5);assert.equal(r.exitPolicy,'flexible-net-trailing');assert.equal(r.takeProfit,null);
 assert.ok(r.entryEvidence.estimatedRoundTripFees<=.5+1e-8);assert.ok(r.entryEvidence.estimatedImmediateExitNet>=-.5-1e-8);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=1.5+1e-8);assert.ok(r.exits.some(e=>e.kind==='sl1p5'&&e.confirmed&&!e.cancelled));assert.equal(r.entryEvidence.targetCosts.advisoryOnly,true);return r;
}
test('current entry policy treats reference profit as advisory and retains requested exits',()=>{
 const p=new DemoEngine({offset:0}).entryPolicy;assert.equal(p.entryFilters,'direction-and-protection');assert.equal(p.maxCommissionShare,null);assert.equal(p.minimumNetAtTarget,null);assert.equal(p.entryDirection,'fresh-directional-quotes');assert.equal(p.lossLimit,1);assert.equal(p.maxLossLimit,1.5);assert.equal(p.sessionTarget,20);assert.equal(p.profitExit,'flexible-net-trailing');
});
for(const side of ['BUY','SELL']){
 for(const shape of ['small-body','opposing-averages'])test(side+' accepts '+shape+' without the old candle-shape, volume or MA gates',async()=>{
  const f=setup({side,shape});assert.equal(minuteMomentumSetup(f.rows(),side,Date.now()),null);const scan=await f.e.scanCandidate(symbol,{side,change:10},f.e.stopEpoch);assert.equal(scan.signal.side,side);await f.e.enter(symbol,scan.signal);protectedEntry(f);
 });
 for(const quotes of ['pullback','spread','extension'])test(side+' allows '+quotes+' when current direction and protected sizing still fit',async()=>{
  const old=await run({side,quotes,strict:true});assert.equal(entries(old).length,0);
  const f=await run({side,quotes}),r=protectedEntry(f);assert.equal(r.entryEvidence.liveDirection.directionOnly,true);
 });
 test(side+' accepts a sub-$1 reference estimate instead of blocking an exchange-sized order',async()=>{
  const opts={side,scale:.1,fee:.00001,capacity:300};const old=await run({...opts,strict:true});assert.equal(entries(old).length,0);assert.match(old.e.entryOutcome,/Reference target leaves less than/);
  const f=await run(opts),r=protectedEntry(f);assert.ok(r.entryEvidence.targetCosts.netAtTarget>0&&r.entryEvidence.targetCosts.netAtTarget<1);
 });
 test(side+' does not require commission to be below 25% of a hypothetical target move',async()=>{
  const opts={side,scale:.25};const old=await run({...opts,strict:true});assert.equal(entries(old).length,0);assert.match(old.e.entryOutcome,/Commission exceeds 25%/);
  const f=await run(opts),r=protectedEntry(f),c=r.entryEvidence.targetCosts;assert.ok(c.commissionAtTarget>c.grossAtTarget*.25);assert.ok(r.entryEvidence.estimatedRoundTripFees<=.5);
 });
 test(side+' still rejects a genuine live reversal and stale executable quote',async()=>{
  for(const quotes of ['reversal','stale']){const f=await run({side,quotes});assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,quotes==='reversal'?/no longer supports/:/stale/);assert.equal(f.e.auto,true);}
 });
}
test('a single fresh directional quote does not need a perfectly advancing second quote',async()=>{
 const f=setup(),base=f.api.call,at=Date.now()-1000;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/ticker/bookTicker')out.time=at;return out;};
 await f.e.enter(symbol,f.signal);protectedEntry(f);
});
test('invalid data, missing commission and exchange minimums still prevent invalid orders',async()=>{
 for(const mode of ['invalid-data','missing-fee','minimum']){
  const f=setup(),base=f.api.call;
  if(mode==='minimum')for(const filter of f.e.meta.get(symbol).filters)if(['LOT_SIZE','MARKET_LOT_SIZE'].includes(filter.filterType))filter.minQty='100';
  f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(mode==='invalid-data'&&p==='/fapi/v1/ticker/bookTicker')out.askPrice='NaN';if(mode==='missing-fee'&&p==='/fapi/v1/commissionRate')return {};return out;};
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0,mode);assert.equal(f.e.state.records.length,0);
 }
});
test('Stop during configuration still cancels the entry',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/leverage')f.e.pause('Manual Stop');return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,false);
});
test('protection failure immediately closes a newly filled directional order',async()=>{
 const f=setup();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(entries(f).length,1);assert.equal(f.position,null);assert.ok(f.e.state.records[0].closedAt);
});
test('an uncertain directional order is reconciled instead of submitted twice',async()=>{
 const f=setup();f.unknownEntry=true;await f.e.enter(symbol,f.signal);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.state.records.length,1);
});
