const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoError}=require('./engine.js');
const {fixture,symbol}=require('./test-fixture.cjs');
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);

test('commission cache shares concurrent reads, isolates symbols and refreshes after five minutes',async()=>{
 const f=fixture();
 assert.deepEqual(await Promise.all([f.e.entryCommission(symbol),f.e.entryCommission(symbol)]),[.0005,.0005]);
 await f.e.entryCommission(symbol);await f.e.entryCommission('HUMAUSDT');
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/commissionRate').length,2);
 f.e.commissionCache().get(symbol).at-=300000;
 await f.e.entryCommission(symbol);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/commissionRate').length,3);
});
for(const field of ['key','signingKey','relayToken'])test('changing '+field+' invalidates cached commission and retry state',async()=>{
 const f=fixture();f.api[field]='first';await f.e.entryCommission(symbol);
 const prior=f.e.commissionCache();prior.set('HUMAUSDT',{retryAt:Date.now()+60000,code:-1000});
 f.api[field]='second';await f.e.entryCommission(symbol);
 assert.notEqual(f.e.commissionCache(),prior);assert.equal(f.e.commissionWait('HUMAUSDT'),null);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/commissionRate').length,2);
 assert.ok(!JSON.stringify(f.saved).includes('second'));
});
test('commission retries back off per symbol, recover automatically, and never log every waiting scan',async()=>{
 const f=fixture(),base=f.api.call;f.e.newRules=true;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/commissionRate'){reads++;throw new DemoError('temporary',-1000);}return base(m,p,q,s);};
 for(const delay of [5000,10000,20000,40000,60000,60000]){
  const start=Date.now();await f.e.enter(symbol,f.signal);const row=f.e.commissionCache().get(symbol);
  assert.ok(row.retryAt>=start+delay&&row.retryAt<=Date.now()+delay);const events=f.e.events.length,count=reads;
  await f.e.enter(symbol,f.signal);await f.e.enter(symbol,f.signal);
  assert.equal(reads,count);assert.equal(f.e.events.length,events);assert.equal(f.e.auto,true);
  assert.match(f.e.entryOutcome,/Commission data unavailable.*retry in.*No order sent; scanning continues/);
  assert.ok(f.calls.every(c=>c.path==='/fapi/v1/userTrades'),'blocked coin repeated expensive account/entry checks');assert.equal(f.calls.length,1);row.retryAt=0;
 }
 f.api.call=base;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.auto,true);
 assert.equal(f.e.commissionCache().get(symbol).attempt,0);
});
test('expired commission is never used when Binance fails; a valid cached rate avoids another read',async()=>{
 const f=fixture(),base=f.api.call;await f.e.entryCommission(symbol);
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/commissionRate')throw new DemoError('unknown',-1000);return base(m,p,q,s);};
 assert.equal(await f.e.entryCommission(symbol),.0005);
 f.e.commissionCache().get(symbol).at-=300000;await f.e.enter(symbol,f.signal);
 assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.equal(f.e.commissionCache().get(symbol).fee,undefined);
});
for(const response of [{},null,{symbol:'OTHERUSDT',takerCommissionRate:'.0001'},...['',null,false,'NaN',-.001,.011].map(rate=>({symbol,takerCommissionRate:rate}))])test('invalid commission cannot authorize an entry: '+JSON.stringify(response),async()=>{
 const f=fixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?response:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);
 assert.ok(f.e.commissionWait(symbol));assert.equal(f.e.commissionCache().get(symbol).fee,undefined);
});
for(const code of [401,403,429,-1003,-1022,-2015])test('commission failure '+code+' still propagates to account-wide handling',async()=>{
 const f=fixture();f.api.call=async()=>{throw new DemoError('blocked',code);};
 await assert.rejects(()=>f.e.enter(symbol,f.signal),e=>e.code===code);assert.equal(f.e.commissionWait(symbol),null);
});
test('a fee failure and its retry delay leave other qualifying coins able to enter',async()=>{
 const f=fixture(),base=f.api.call,first='HUMAUSDT';f.e.newRules=true;
 f.e.symbols=[first,symbol];f.e.meta.set(first,f.e.meta.get(symbol));f.e.moversCheckedAt=Date.now();let feeReads=0;
 f.e.scanCandidate=async s=>({symbol:s,signal:{...f.signal},intervalMs:300000,scanMs:0});
 f.api.call=async(m,p,q={},s)=>{if(q.symbol===first&&p==='/fapi/v1/commissionRate'){feeReads++;throw new DemoError('temporary',-1000);}return base(m,p,q,s);};
 await f.e.scan();assert.equal(entries(f).length,1);assert.ok(f.e.owned(symbol)?.exitsReady);
 await f.e.scan();assert.equal(feeReads,1);assert.equal(f.e.auto,true);assert.match(f.e.scanned.find(r=>r.symbol===first).reason,/retry in/);
});
test('a closed coin is eligible after ten minutes, using Binance-adjusted time and a new candle',async()=>{
 const f=fixture();f.e.newRules=true;f.api.offset=30000;
 const r={id:'bd1_old',symbol,side:'BUY',at:Date.now()-700000,closedAt:Date.now()+f.api.offset-590000,signalClose:f.signal.close-300000};f.e.state.records=[r];
 await f.e.enter(symbol,f.signal);assert.match(f.e.entryOutcome,/cooldown: (9|10)s remaining/);assert.equal(f.calls.length,0);
 r.closedAt-=11000;assert.equal(f.e.reentryWait(symbol,f.signal),null);
 f.api.offset=0;r.closedAt=Date.now()-610000;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.auto,true);
});
test('a definitely rejected entry can retry after 60 seconds without marking the candle as traded',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.records=[{id:'bd1_rejected',symbol,side:'BUY',at:Date.now()-61000,signalClose:f.signal.close,rejected:true}];
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.auto,true);
});
test('a filled candle remains consumed after the cooldown, preventing duplicate re-entry',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.records=[{id:'bd1_closed',symbol,side:'BUY',at:Date.now()-800000,closedAt:Date.now()-610000,signalClose:f.signal.close}];
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/traded/i);
});
