const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoEngine,DemoError,bandEntryCosts}=require('./engine.js');
const {fixture,setTradeNet,symbol}=require('./test-fixture.cjs');
const entries=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);
const closes=f=>f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.reduceOnly);
function readError(path,code=503){const e=new DemoError('Temporary read failure',code);e.requestMethod='GET';e.requestPath=path;return e;}
async function managed(){
 const f=fixture();f.e.newRules=true;await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol));
 f.e.bandRules=true;f.e.tradingReady=true;f.e.syncDaily=()=>{};f.e.symbols=[];
 await f.e.refresh();await f.e.reconcile();return f;
}
test('income-summary failure cannot prevent an armed profit pullback exit or cancel Auto',async()=>{
 const f=await managed(),r=f.e.owned(symbol);setTradeNet(f,6);await f.e.reconcile();assert.equal(r.profitFloor,5);
 setTradeNet(f,4.8);f.e.positionAt=0;const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>{if(p==='/fapi/v1/income'&&!q.symbol)throw readError(p);return base(m,p,q,s);};
 await f.e.tick();assert.ok(r.closedAt);assert.equal(r.closeReason,'Stepped net profit pullback');assert.equal(f.e.auto,true);
 assert.ok(f.e.retryAt>Date.now());assert.ok(f.e.entryHold);assert.equal(closes(f).length,1);
});
test('position management still runs during an entry-only read retry',async()=>{
 const f=await managed(),r=f.e.owned(symbol);setTradeNet(f,9);await f.e.reconcile();assert.equal(r.profitFloor,8);
 setTradeNet(f,7.5);f.e.positionAt=0;assert.equal(f.e.scheduleReadRecovery(readError('/fapi/v1/exchangeInfo')),true);
 let scans=0;f.e.scan=async()=>scans++;
 await f.e.tick();assert.ok(r.closedAt);assert.equal(closes(f).length,1);assert.equal(f.e.auto,true);assert.equal(scans,0);
});
test('manual Stop stops entries but leaves profit management running',async()=>{
 const f=await managed(),r=f.e.owned(symbol);setTradeNet(f,6);await f.e.reconcile();setTradeNet(f,4.8);f.e.positionAt=0;
 f.e.pause('User Stop');let scans=0;f.e.scan=async()=>scans++;
 await f.e.tick();assert.equal(f.e.auto,false);assert.ok(r.closedAt);assert.equal(scans,0);assert.equal(closes(f).length,1);
});
test('unmanaged orders hold new entries and Auto resumes when fresh checks show them gone',async()=>{
 const f=await managed(),base=f.api.call;let unmanaged=true,scans=0;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/openOrders'&&unmanaged?[{symbol:'MANUALUSDT',clientOrderId:'manual'}]:base(m,p,q,s);
 f.e.scan=async()=>scans++;f.e.lastFullCheck=0;await f.e.tick();assert.equal(f.e.auto,true);assert.match(f.e.entryHold,/Unmanaged/);assert.equal(scans,0);
 unmanaged=false;f.e.lastFullCheck=0;await f.e.tick();assert.equal(f.e.auto,true);assert.equal(f.e.entryHold,'');assert.equal(scans,1);
});
test('a transient query failure with a pending close keeps Auto armed, never resubmits blindly',async()=>{
 const f=await managed(),r=f.e.owned(symbol);f.failClose=true;
 let error;try{await f.e.close(symbol);}catch(e){error=e;}assert.ok(error?.uncertain);const id=r.pendingClose;assert.ok(id);
 f.e.handleRunError(error);assert.equal(f.e.auto,true);assert.ok(f.e.entryHold);const before=closes(f).length;
 assert.equal(f.e.scheduleReadRecovery(readError('/fapi/v1/order')),true);f.e.positionAt=0;
 await f.e.tick();assert.equal(r.pendingClose,id);assert.equal(closes(f).length,before);assert.equal(entries(f).length,1);assert.equal(f.e.auto,true);
});
test('one failed position reconciliation does not prevent checking another position',async()=>{
 const e=new DemoEngine({offset:0},null,()=>{});e.auto=true;
 e.state.records=['AAAUSDT','BBBUSDT'].map((s,i)=>({id:'bd1_'+i,symbol:s,side:'BUY',observedOpen:true,entryStatus:'FILLED',at:Date.now(),orderId:i+1}));
 e.positions=e.state.records.map(r=>({symbol:r.symbol,positionAmt:'1',entryPrice:'100',markPrice:'100',unRealizedProfit:'0',positionSide:'BOTH'}));
 const seen=[];e.reconcileBandExits=async r=>{seen.push(r.symbol);if(r.symbol==='AAAUSDT')throw readError('/fapi/v1/userTrades');};
 await assert.rejects(()=>e.reconcile());assert.deepEqual(seen,['AAAUSDT','BBBUSDT']);assert.ok(e.state.records[0].reconcileError);
});
test('exchange-wide cooldown is respected without turning off Auto or issuing reads',async()=>{
 const f=await managed();f.e.positionAt=0;f.api.blockUntil=Date.now()+60000;const before=f.calls.length;
 await f.e.tick();assert.equal(f.calls.length,before);assert.equal(f.e.auto,true);assert.ok(f.e.retryAt>=f.api.blockUntil);
});
test('Start intent survives an unsettled-order check, but a later manual Stop cancels it',async()=>{
 const f=fixture();f.e.bandRules=true;f.e.auto=false;
 f.e.startChecked=async()=>{throw new DemoError('Order still settling');};await f.e.start();assert.equal(f.e.auto,true);assert.equal(f.e.startPending,true);
 f.e.pause('User Stop');assert.equal(f.e.auto,false);assert.equal(f.e.startPending,false);assert.equal(f.e.retryAt,0);
});
test('Manual Stop during an in-flight failing Start is never undone',async()=>{
 const f=fixture();f.e.bandRules=true;let reject;f.e.startChecked=()=>new Promise((_,r)=>reject=r);
 const start=f.e.start();f.e.pause('User Stop');reject(readError('/fapi/v3/account'));await assert.rejects(()=>start);
 assert.equal(f.e.auto,false);assert.equal(f.e.startPending,false);assert.equal(f.e.retryAt,0);
});
test('an entry hold blocks direct entries without any API call',async()=>{
 const f=fixture();f.e.bandRules=true;f.e.holdEntries('Unresolved order');await f.e.enter(symbol,f.signal);
 assert.equal(f.calls.length,0);assert.equal(f.e.auto,true);assert.equal(entries(f).length,0);
});
for(const side of ['BUY','SELL'])test(side+' high commission needs substantial net target room, with no blanket $1 cap',()=>{
 const signal={side,bands:{middle:side==='BUY'?104:96}};
 const good=bandEntryCosts(signal,100,30,.0005);assert.equal(good.reason,null);assert.ok(good.commissionAtTarget>1);assert.ok(good.netAtTarget>5);
 const costly=bandEntryCosts({side,bands:{middle:side==='BUY'?100.3:99.7}},100,30,.0005);assert.match(costly.reason,/25%/);
 const tiny=bandEntryCosts({side,bands:{middle:side==='BUY'?100.1:99.9}},100,3,.00001);assert.match(tiny.reason,/less than \$5/);
});
