'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoEngine,DemoError,earlyLossDecision,bollingerSetup}=require('./engine.js');
const {fixture,entryBars,setTradeNet,symbol}=require('./test-fixture.cjs');
const now=1800000000000;
function inputs(side='BUY'){
 const sign=side==='BUY'?1:-1;
 const r={side,entry:100,tick:'.01',signal:{atr:.2},openedAt:now-30000};
 const quote={net:-2,gross:-1.8,price:100-sign*.03,at:now,quantity:60};
 const samples=[0,.01,.03].map((d,i)=>({price:100-sign*d,at:now-2000+i*1000,entry:100,quantity:60}));
 return {r,quote,samples,sign};
}
for(const side of ['BUY','SELL']){
 test(side+' closes only inside the $2 to $6 loss window with confirmed deterioration',()=>{
  const {r,quote,samples}=inputs(side);
  for(const net of [-2,-2.01,-4.5,-5.999])assert.equal(earlyLossDecision(r,{...quote,net},now,samples).exit,true);
  for(const net of [-.5,-1.99,-1.999999,-6,-6.01,-12])assert.equal(earlyLossDecision(r,{...quote,net},now,samples).exit,false);
 });
 test(side+' holds a fee-only loss, positive net, and one noisy tick',()=>{
  const {r,quote,samples}=inputs(side);
  assert.equal(earlyLossDecision(r,{...quote,gross:0},now,samples).exit,false);
  assert.equal(earlyLossDecision(r,{...quote,net:.1},now,samples).exit,false);
  assert.equal(earlyLossDecision(r,quote,now,samples.slice(-1)).exit,false);
 });
 test(side+' latest recovery cancels an early exit even while net remains negative',()=>{
  const {r,quote,samples,sign}=inputs(side);
  assert.equal(earlyLossDecision(r,{...quote,price:100-sign*.025},now,samples).exit,false);
 });
 test(side+' a strong opposing candle must close after entry and still be confirmed by price',()=>{
  const {r,quote,sign}=inputs(side);
  const m={closedAt:now-1000,atr:.2,close:quote.price,open:quote.price+sign*.15,previousClose:quote.price+sign*.1,fast:quote.price+sign*.02,slow:quote.price+sign*.04,threeBarsAgo:quote.price+sign*.2};
  assert.equal(earlyLossDecision(r,quote,now,[],m).mode,'candle');
  assert.equal(earlyLossDecision(r,{...quote,net:-1.99},now,[],m).exit,false);
  assert.equal(earlyLossDecision(r,quote,now,[],{...m,closedAt:r.openedAt-1}).exit,false);
  assert.equal(earlyLossDecision(r,quote,now,[],{...m,close:quote.price-sign*.1}).exit,false);
 });
}
for(const [name,change] of [
 ['stale price',x=>x.quote.at=now-5001],['future price',x=>x.quote.at=now+1],
 ['invalid price',x=>x.quote.price=NaN],['unavailable volatility',x=>x.r.signal.atr=0],
 ['old observations',x=>x.samples.forEach(q=>q.at-=16000)],
 ['duplicate observations',x=>x.samples.forEach(q=>q.at=now)],
 ['resized position',x=>x.quote.quantity=30],['changed entry',x=>x.r.entry=101]
])test('early exit refuses '+name,()=>{
 const x=inputs();change(x);assert.equal(earlyLossDecision(x.r,x.quote,now,x.samples).exit,false);
});
function bandBars(side){
 const ms=300000,end=Math.floor(Date.now()/ms)*ms;
 const rows=Array.from({length:30},(_,i)=>{const c=105+.2*Math.sin(i);return [end-(30-i)*ms,c-.1,c+.3,c-.3,c,100,end-(29-i)*ms-1];});
 Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});
 return side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]);
}
async function opened(side='BUY'){
 const f=fixture(),base=f.api.call;f.e.newRules=f.e.bandRules=true;f.signal.side=side;
 f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.00001'}:p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:20,notionalCap:1000000,notionalFloor:0}]}:p==='/fapi/v1/klines'?(q.interval==='5m'?bandBars(side):entryBars(side)):base(m,p,q,s);
 f.signal=bollingerSetup(bandBars(side),side,Date.now());await f.e.enter(symbol,f.signal);
 const r=f.e.owned(symbol);assert.ok(r);r.signal.atr=.2;r.earlyLossQuotes=[];
 return f;
}
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
async function deteriorate(f,t){
 for(const net of [-.2,-.8]){t.mock.timers.tick(1100);setTradeNet(f,net);await f.e.reconcile();assert.ok(f.position);}
 t.mock.timers.tick(1100);setTradeNet(f,-2.2);await f.e.reconcile();
}
for(const side of ['BUY','SELL'])test(side+' integration closes once around $2 loss using reduceOnly and preserves other strategy values',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await opened(side),r=f.e.owned(symbol),policy=structuredClone(f.e.entryPolicy);
 await deteriorate(f,t);
 assert.ok(r.closedAt);assert.equal(r.closeReason,'Early adverse-move exit');assert.equal(closes(f).length,1);
 assert.equal(closes(f)[0].p.side,side==='BUY'?'SELL':'BUY');assert.equal(f.e.auto,true);
 assert.equal(r.lossLimit,6);assert.equal(r.maxLossLimit,12);assert.deepEqual(f.e.entryPolicy,policy);
 assert.equal(f.e.tradeReport().botRecords.at(-1).earlyLossReview.exit,true);
 await f.e.reconcile();assert.equal(closes(f).length,1);
});
test('recovery on final pre-order quote prevents an early close',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);
 const close=f.e.close.bind(f.e);f.e.close=async(...args)=>{if(args[1]==='Early adverse-move exit')setTradeNet(f,-.4);return close(...args);};
 await deteriorate(f,t);assert.ok(f.position);assert.equal(closes(f).length,0);assert.equal(r.earlyLossReview.exit,false);
});
test('a gap to the backup loss threshold uses the existing hard loss exit',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);
 const close=f.e.close.bind(f.e);f.e.close=async(...args)=>{if(args[1]==='Early adverse-move exit')setTradeNet(f,-13);return close(...args);};
 await deteriorate(f,t);assert.ok(r.closedAt);assert.equal(r.closeReason,'$12 net trade loss');
});
test('missing early candle data does not close a small loser or remove its backup stop',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-2.01);f.e.scanBars=async()=>{throw new DemoError('unavailable',503);};
 await f.e.reconcile();assert.ok(f.position);assert.equal(closes(f).length,0);assert.match(r.earlyLossReview.reason,/unavailable/);
 assert.ok(r.exits.some(e=>e.kind==='sl12'&&e.confirmed&&!e.cancelled));
});
test('manual Stop still permits early protection of an already open position',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened();f.e.pause('Manual Stop');
 await deteriorate(f,t);assert.equal(f.position,null);assert.equal(f.e.auto,false);
});
test('unknown early close response is journaled and never blindly resubmitted',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);f.failClose=true;
 await assert.rejects(()=>deteriorate(f,t),e=>e.uncertain);assert.ok(r.pendingClose);assert.equal(closes(f).length,1);
 await assert.rejects(()=>f.e.reconcile());assert.equal(closes(f).length,1);
});
test('restart preserves existing armed profit floors',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);
 setTradeNet(f,9);await f.e.reconcile();assert.equal(r.profitFloor,8);
 r.earlyLossQuotes=inputs().samples;const restored=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});restored.entryPolicy={...f.e.entryPolicy};restored.meta=f.e.meta;
 await restored.refresh();await restored.reconcile();assert.equal(restored.owned(symbol).profitFloor,8);
});
test('a small stable loss is held and stale observations are discarded after restart',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);
 setTradeNet(f,-2.01);await f.e.reconcile();t.mock.timers.tick(1100);await f.e.reconcile();t.mock.timers.tick(1100);await f.e.reconcile();
 assert.ok(f.position);assert.equal(closes(f).length,0);
 t.mock.timers.tick(16000);const restored=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});restored.meta=f.e.meta;
 await restored.refresh();await restored.reconcile();assert.equal(restored.owned(symbol).earlyLossQuotes.length,1);assert.ok(f.position);
});
for(const side of ['BUY','SELL'])test(side+' opposing completed candle triggers the integrated early exit',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(side),r=f.e.owned(symbol);
 r.openedAt-=120000;setTradeNet(f,-2.2);
 const raw=entryBars(side==='BUY'?'SELL':'BUY'),delta=Number(f.position.markPrice)-100;
 f.e.scanBars=async()=>raw.map(b=>[b[0],b[1]+delta,b[2]+delta,b[3]+delta,b[4]+delta,b[5],b[6]]);
 await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Early adverse-move exit');assert.equal(r.earlyLossReview.mode,'candle');assert.equal(closes(f).length,1);
});
for(const side of ['BUY','SELL'])test(side+' confirmed deterioration below $2 net loss is held',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(side),r=f.e.owned(symbol);
 for(const net of [-.2,-.8,-1.99]){t.mock.timers.tick(1100);setTradeNet(f,net);await f.e.reconcile();}
 assert.ok(f.position);assert.equal(closes(f).length,0);assert.match(r.earlyLossReview.reason,/at least \$2/);
});
test('final after-fee recovery above -$2 cancels an early close even when price still deteriorates',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await opened(),r=f.e.owned(symbol);
 const estimate=f.e.closingEstimate.bind(f.e);f.e.closingEstimate=async(...args)=>{
  const net=await estimate(...args);
  if(args[2]?.forceAccounting&&r.earlyLossReview?.exit){r.closingEstimate.net=-1.99;return -1.99;}
  return net;
 };
 await deteriorate(f,t);assert.ok(f.position);assert.equal(closes(f).length,0);assert.equal(r.earlyLossReview.exit,false);assert.match(r.earlyLossReview.reason,/at least \$2/);
});

