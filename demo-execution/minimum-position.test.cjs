'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,minuteMomentumSetup}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
function setup({side='BUY',ceiling=100,capacity=150,scale=1,available=5000,finalSpread=0,finalWick=0,finalMove=0}={}){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;f.signal.side=side;
 let reads=0,quotes=0;const base=f.api.call;
 f.api.call=async(m,p,q={},signed)=>{
  if(p==='/fapi/v1/klines'){assert.equal(q.interval,'1m');const bars=entryBars(side,Date.now(),scale);if(++reads===2)bars[10][2]+=finalWick;return bars;}
  if(p==='/fapi/v1/leverageBracket')return {symbol,brackets:[{initialLeverage:ceiling,notionalCap:1000000,notionalFloor:0}]};
  const out=await base(m,p,q,signed);
  if(p==='/fapi/v3/account')out.assets[0].availableBalance=String(available);
  if(m==='POST'&&p==='/fapi/v1/leverage')out.maxNotionalValue=String(typeof capacity==='function'?capacity(q.leverage):capacity);
  if(p==='/fapi/v1/ticker/bookTicker'&&++quotes>=3){out.bidPrice=String(100+finalMove-finalSpread/2);out.askPrice=String(100+finalMove+finalSpread/2);}
  return out;
 };
 f.signal=minuteMomentumSetup(entryBars(side,Date.now(),scale),side,Date.now(),()=>{},{directionOnly:true});assert.ok(f.signal);return f;
}
async function opened(options){const f=setup(options);await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol),f.e.entryOutcome);assert.equal(entries(f).length,1);return f;}
test('the only policy addition to V1.83 is the $150 minimum position value',()=>{
 const {minimumPositionNotional,...policy}=new DemoEngine({offset:0}).entryPolicy;assert.equal(minimumPositionNotional,150);
 assert.deepEqual(policy,{margin:300,marginMode:'risk-capped',leverageMode:'highest-fee-compatible',maxLeverage:100,entryFilters:'direction-and-protection',maxCommissionShare:null,maxCommissionLossShare:.5,minimumNetAtTarget:null,strategy:'minute-momentum-with-band-fallback',strategies:['minute-momentum','bollinger-wr','trend-continuation'],trendTimeframes:[1],trendReferenceAtr:2,trendVolatilityLossLimit:1.5,reentryCooldownMs:30000,entryDirection:'fresh-directional-quotes',timeframes:[1,2,3,4,5,6,7,8,9,10,15,20,30,60],lossLimit:1,maxLossLimit:1.5,lossExit:'tight-net-stop',earlyLossExit:null,earlyLossMin:null,profitStart:1,profitStep:null,profitTrailMin:.5,profitTrailFraction:.1,takeProfit:null,profitExit:'flexible-net-trailing',lossReduction:0,sessionTarget:20,sessionExit:'trail-open-positions',sessionTargetBasis:'booked-net',bollingerPeriod:20,bollingerDeviations:2,williamsPeriod:14});
});
for(const side of ['BUY','SELL']){
 for(const ceiling of [1,10,50,100])test(side+' $150 position at '+ceiling+'x uses $'+150/ceiling+' margin',async()=>{
  const f=await opened({side,ceiling}),r=f.e.owned(symbol);assert.equal(r.leverage,ceiling);assert.equal(r.estimatedEntryNotional,150);assert.equal(r.minimumEntryNotional,150);assert.equal(r.estimatedEntryMargin,150/ceiling);assert.equal(Number(entries(f)[0].p.quantity)*r.entryEvidence.estimatedEntryPrice,150);
  assert.equal(r.lossLimit,1);assert.equal(r.maxLossLimit,1.5);assert.equal(r.exitPolicy,'flexible-net-trailing');assert.ok(r.exits.some(e=>e.kind==='sl1p5'&&e.confirmed&&!e.cancelled));
  const report=f.e.tradeReport().botRecords.at(-1);assert.equal(report.minimumEntryNotional,150);assert.equal(report.estimatedEntryNotional,150);
 });
 test(side+' preserves an already-valid larger position instead of forcing exactly $150',async()=>{
  const f=await opened({side,capacity:1000000});assert.ok(f.e.owned(symbol).estimatedEntryNotional>150);
 });
 test(side+' skips a sub-$150 risk-sized order without widening the existing stop',async()=>{
  const options={side,scale:3,capacity:1000000},old=setup(options);old.e.entryPolicy.minimumPositionNotional=0;await old.e.enter(symbol,old.signal);assert.equal(entries(old).length,1);assert.ok(old.e.owned(symbol).estimatedEntryMargin*old.e.owned(symbol).leverage<150);
  const f=setup(options);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Minimum \$150 position value/);assert.equal(f.e.entryPolicy.lossLimit,1);assert.equal(f.e.entryPolicy.maxLossLimit,1.5);
 });
 for(const net of [-1,2])test(side+' at the minimum retains '+(net<0?'the $1 net stop':'the uncapped profit trail'),async()=>{
  const f=await opened({side}),r=f.e.owned(symbol);setTradeNet(f,net);await f.e.reconcile();if(net<0){assert.ok(r.closedAt);assert.equal(r.closeReason,'$1 net trade loss');}else{assert.ok(!r.closedAt);assert.equal(r.profitFloor,1.5);setTradeNet(f,1.5);await f.e.reconcile();assert.ok(r.closedAt);}
 });
}
test('Binance minimum above $150 still takes precedence',async()=>{
 const f=setup({capacity:300});f.e.meta.get(symbol).filters.find(x=>x.filterType==='MIN_NOTIONAL').notional='200';await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol).estimatedEntryNotional>=200);
 const limited=setup({capacity:199});limited.e.meta.get(symbol).filters.find(x=>x.filterType==='MIN_NOTIONAL').notional='200';await limited.e.enter(symbol,limited.signal);assert.equal(entries(limited).length,0);
});
test('available margin includes fees and never permits a smaller notional fallback',async()=>{
 const f=await opened({available:1.65});assert.equal(f.e.owned(symbol).estimatedEntryNotional,150);assert.equal(f.e.owned(symbol).estimatedEntryMargin,1.5);
 const short=setup({available:1.5});await short.e.enter(symbol,short.signal);assert.equal(entries(short).length,0);assert.match(short.e.entryOutcome,/\$150 position value/);
});
test('leverage capacity fallback keeps the $150 minimum',async()=>{
 const f=await opened({capacity:l=>l>50?149:200});const r=f.e.owned(symbol);assert.equal(r.leverage,50);assert.ok(r.estimatedEntryNotional>=150&&r.estimatedEntryNotional<=200);
 const blocked=setup({capacity:149});await blocked.e.enter(symbol,blocked.signal);assert.equal(entries(blocked).length,0);assert.match(blocked.e.entryOutcome,/at least \$150 position value/);
});
test('lot rounding must fit both the minimum value and the existing capacity',async()=>{
 for(const [capacity,expected] of [[160,false],[220,true]]){const f=setup({capacity});for(const filter of f.e.meta.get(symbol).filters)if(['LOT_SIZE','MARKET_LOT_SIZE'].includes(filter.filterType))filter.stepSize='.7';await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,expected?1:0);if(expected)assert.equal(f.e.owned(symbol).estimatedEntryNotional,210);}
});
for(const options of [{finalSpread:.6},{finalWick:30},{finalMove:-.01}])test('final quote or volatility changes cannot send less than the minimum: '+JSON.stringify(options),async()=>{
 const f=setup(options);await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/Final quote.*minimum \$150/);assert.equal(f.e.auto,true);
});
test('existing smaller positions are not topped up or releveraged',async()=>{
 const f=setup({capacity:100});f.e.entryPolicy.minimumPositionNotional=0;await f.e.enter(symbol,f.signal);const qty=f.position.positionAmt,leverage=f.e.owned(symbol).leverage;f.e.entryPolicy=new DemoEngine({offset:0}).entryPolicy;
 await f.e.reconcile();await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.position.positionAmt,qty);assert.equal(f.e.owned(symbol).leverage,leverage);
});
test('market fills below the planned $150 do not cause a second top-up order',async()=>{
 const f=setup(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/order'&&!q.reduceOnly){out.avgPrice='99.9';f.position.entryPrice='99.9';f.position.markPrice='99.9';}return out;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.owned(symbol).estimatedEntryNotional,150);assert.ok(Number(f.position.positionAmt)*Number(f.position.entryPrice)<150);
});
