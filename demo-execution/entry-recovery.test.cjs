const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError}=require('./engine.js');
test('valid commission is cached briefly per account/symbol, never reused after expiry or account change',async()=>{
 let calls=0,rate='.0005';const api={key:'first',call:async()=>{calls++;return {takerCommissionRate:rate};}},e=new DemoEngine(api,null,()=>{});
 assert.equal(await e.entryCommissionRate('AAAUSDT'),.0005);rate='.0007';assert.equal(await e.entryCommissionRate('AAAUSDT'),.0005);assert.equal(calls,1);
 assert.equal(await e.entryCommissionRate('BBBUSDT'),.0007);assert.equal(calls,2);e.entryFeeCache.get('AAAUSDT').expires=0;assert.equal(await e.entryCommissionRate('AAAUSDT'),.0007);assert.equal(calls,3);
 api.key='second';await e.entryCommissionRate('AAAUSDT');assert.equal(calls,4);
});
test('failed commission reads back off only that symbol and never assume zero or expired fees',async()=>{
 const calls=[];let fail=true;const api={key:'test',call:async(m,p,q)=>{calls.push(q.symbol);if(q.symbol==='AAAUSDT'&&fail)throw new DemoError('read failed',-1000);return {takerCommissionRate:'.0005'};}},e=new DemoEngine(api,null,()=>{});
 await assert.rejects(()=>e.entryCommissionRate('AAAUSDT'));await assert.rejects(()=>e.entryCommissionRate('AAAUSDT'),/retry in/);assert.equal(calls.length,1);
 assert.equal(await e.entryCommissionRate('BBBUSDT'),.0005);assert.equal(calls.length,2);e.entryFeeCache.get('AAAUSDT').retryAt=0;fail=false;assert.equal(await e.entryCommissionRate('AAAUSDT'),.0005);
 e.entryFeeCache.get('AAAUSDT').expires=0;fail=true;await assert.rejects(()=>e.entryCommissionRate('AAAUSDT'));assert.equal(e.entryFeeCache.get('AAAUSDT').rate,undefined);
});
test('commission auth failures do not become per-symbol retry filters',async()=>{
 const error=new DemoError('auth',-2015),e=new DemoEngine({key:'test',call:async()=>{throw error;}},null,()=>{});
 await assert.rejects(()=>e.entryCommissionRate('AAAUSDT'),e=>e===error&&!e.candidateRead);assert.equal(e.entryFeeCache.size,0);
});
