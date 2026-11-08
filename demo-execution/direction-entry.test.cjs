'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {entryConfirmation,bandEntryLiveCheck,bollingerSetup}=require('./engine.js');
const {fixture,entryBars,symbol}=require('./test-fixture.cjs');
const now=1800000030000;
function input(side='BUY'){
 const sign=side==='BUY'?1:-1,raw=entryBars(side,now),momentum=entryConfirmation(raw,{side,setupType:'bollinger-wr',intervalMs:300000},now);
 const before={symbol,bidPrice:100-sign*.08,askPrice:100-sign*.08,time:now-1000};
 const quote={symbol,bidPrice:100,askPrice:100,time:now};
 return {side,sign,raw,momentum,before,quote,options:{symbol,side,tick:.01,now,raw}};
}
for(const side of ['BUY','SELL']){
 test(side+' requires a directional closed minute candle for every Bollinger timeframe',()=>{
  const f=input(side),raw=structuredClone(f.raw),last=raw.at(-1);
  last[1]=last[4]+f.sign*.02;last[4]=raw.at(-2)[4]-f.sign*.01;
  last[2]=Math.max(last[1],last[4])+.03;last[3]=Math.min(last[1],last[4])-.03;
  for(const minutes of [2,5,15,60])assert.match(entryConfirmation(raw,{side,setupType:'bollinger-wr',intervalMs:minutes*60000},now).reason,/direction does not confirm/);
 });
 test(side+' accepts aligned closed candles and fresh advancing bid and ask',()=>{
  const f=input(side),out=bandEntryLiveCheck(f.before,f.quote,f.momentum,f.options);
  assert.equal(out.reason,null);assert.ok(out.bidMove>=out.minimumMove);assert.ok(out.askMove>=out.minimumMove);
 });
 for(const kind of ['flat','opposing','spread-only','same timestamp','stale first','stale final','future','too small','reversal after settings','out-of-order checkpoint'])test(side+' rejects '+kind+' live evidence',()=>{
  const f=input(side);let options={...f.options};
  if(kind==='flat')Object.assign(f.before,{bidPrice:100,askPrice:100});
  if(kind==='opposing')Object.assign(f.before,{bidPrice:100+f.sign*.08,askPrice:100+f.sign*.08});
  if(kind==='spread-only')Object.assign(f.before,side==='BUY'?{bidPrice:100,askPrice:100.01}:{bidPrice:99.99,askPrice:100});
  if(kind==='same timestamp')f.before.time=now;
  if(kind==='stale first')f.before.time=now-10001;
  if(kind==='stale final')Object.assign(f.before,{time:now-6001}),f.quote.time=now-6000;
  if(kind==='future')f.quote.time=now+1;
  if(kind==='too small')Object.assign(f.before,{bidPrice:100-f.sign*.001,askPrice:100-f.sign*.001});
  if(kind==='reversal after settings')options.checkpoint={bidPrice:100+f.sign*.01,askPrice:100+f.sign*.01,time:now-500};
  if(kind==='out-of-order checkpoint')options.checkpoint={...f.quote,time:now+1};
  assert.ok(bandEntryLiveCheck(f.before,f.quote,f.momentum,options).reason);
 });
 test(side+' refuses an opposing forming candle and a late chase',()=>{
  const f=input(side),start=f.momentum.closedAt+1,open=100-f.sign*.01,close=open-f.sign*.02;
  f.raw.push([start,open,Math.max(open,close)+.01,Math.min(open,close)-.01,close,10,start+59999]);
  assert.match(bandEntryLiveCheck(f.before,f.quote,f.momentum,f.options).reason,/forming.*against/);
  f.raw.pop();f.quote.bidPrice=f.quote.askPrice=100+f.sign*f.momentum.atr;
  assert.match(bandEntryLiveCheck(f.before,f.quote,f.momentum,f.options).reason,/extended/);
 });
 test(side+' refuses malformed, stale, and reversed candle evidence',()=>{
  const f=input(side);
  assert.ok(bandEntryLiveCheck(f.before,f.quote,{...f.momentum,closedAt:now-75001},f.options).reason);
  assert.ok(bandEntryLiveCheck(f.before,f.quote,{...f.momentum,reason:'opposing'},f.options).reason);
  f.raw.push([now,100,99,101,100,10,now+59999]);
  assert.match(bandEntryLiveCheck(f.before,f.quote,f.momentum,f.options).reason,/invalid/);
 });
}
function setup(side='BUY'){
 const f=fixture();f.e.newRules=f.e.bandRules=true;f.signal.side=side;const base=f.api.call,ms=300000,end=Math.floor(Date.now()/ms)*ms;
 const rows=Array.from({length:30},(_,i)=>{const c=105+.2*Math.sin(i);return [end-(30-i)*ms,c-.1,c+.3,c-.3,c,100,end-(29-i)*ms-1];});
 Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});
 const raw=side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]);
 f.signal=bollingerSetup(raw,side,Date.now());
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.00001'}:p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:20,notionalCap:1000000,notionalFloor:0}]}:base(m,p,q,s);
 return f;
}
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
for(const side of ['BUY','SELL']){
 test(side+' submits once only after the final recheck and reports the direction evidence',async()=>{
  const f=setup(side);await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);
  assert.ok(r,f.e.entryOutcome);assert.equal(entries(f).length,1);assert.equal(r.entryEvidence.liveDirection.reason,null);
  assert.equal(f.e.tradeReport().botRecords[0].entryEvidence.liveDirection.side,side);
  assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/klines'&&c.p.interval==='1m').length,2);
 });
 test(side+' cancels entry when the minute candle reverses during exchange setup',async()=>{
  const f=setup(side),base=f.api.call;let reads=0;
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'&&++reads===2?entryBars(side==='BUY'?'SELL':'BUY'):base(m,p,q,s);
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.state.records.length,0);assert.match(f.e.entryOutcome,/Final direction check/);assert.equal(f.e.auto,true);
 });
 test(side+' skips flat live prices and keeps scanning without a blind order',async()=>{
  const f=setup(side),base=f.api.call;
  f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'100',askPrice:'100',bidQty:'1000',askQty:'1000',time:Date.now()}:base(m,p,q,s);
  await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.state.records.length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Waiting for/);
 });
}
test('a failed final candle read blocks entry and a later fresh check can recover',async()=>{
 const f=setup(),base=f.api.call;let reads=0,fail=true;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines'&&++reads===2&&fail)throw Error('candle read failed');return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.entryResult.kind,'data-unavailable');assert.equal(f.e.auto,true);
 fail=false;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);
});
test('manual Stop during final candle recheck prevents dispatch',async()=>{
 const f=setup(),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(p==='/fapi/v1/klines'&&++reads===2)f.e.pause('Manual Stop');return result;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,false);
});
