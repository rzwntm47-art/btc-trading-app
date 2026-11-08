'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DemoEngine,DemoError}=require('./engine.js');
const symbol='MEGAUSDT';
function fixture(side='BUY'){
 const at=Date.now()-3600000,calls=[],saved=[],r={id:'bd1_missed_position',symbol,side,at,orderId:10,entryStatus:'FILLED',entry:1,filledQty:100,fee:.0005,exitsReady:true,exits:[{id:'bdx_'+ 'a'.repeat(24),confirmed:true}]};
 const order={symbol,side,clientOrderId:r.id,orderId:10,status:'FILLED',executedQty:'100',avgPrice:'1',updateTime:at};
 const trade=(id,orderId,side,qty,time=at+1000)=>({id,orderId,symbol,side,qty,positionSide:'BOTH',time});
 const f={r,order,calls,saved,positions:[],orders:[],algos:[],trades:[trade(100,10,side,'100',at),trade(101,11,side==='BUY'?'SELL':'BUY','100')],trade};
 const api={offset:0,key:'test',call:async(method,path,p={})=>{
  calls.push({method,path,p});assert.equal(method,'GET','Recovery must never submit or cancel an exchange order');
  if(path==='/fapi/v1/order')return {...f.order};
  if(path==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000'}],positions:f.positions};
  if(path==='/fapi/v3/positionRisk')return f.positions;
  if(path==='/fapi/v1/openOrders')return f.orders;
  if(path==='/fapi/v1/openAlgoOrders')return f.algos;
  if(path==='/fapi/v1/userTrades')return f.trades.filter(t=>(!p.orderId||String(t.orderId)===String(p.orderId))&&(!p.fromId||BigInt(t.id)>=BigInt(p.fromId))).slice(0,p.limit);
  if(path==='/fapi/v1/income')return [];
  throw Error('Unexpected read '+path);
 }};
 f.e=new DemoEngine(api,{version:1,records:[r],startedAt:at,goal:false},s=>saved.push(structuredClone(s)));f.e.connected=true;f.e.tradingReady=true;f.e.auto=true;f.e.metaAt=Date.now();f.e.symbols=[];return f;
}
for(const side of ['BUY','SELL'])test(side+' filled MEGAUSDT closed before its first position snapshot is reconciled without another order',async()=>{
 const f=fixture(side);await f.e.reconcile();assert.ok(f.r.closedAt);assert.equal(f.e.active().length,0);assert.equal(f.e.state.records.length,1);assert.equal(f.r.observedOpen,undefined);assert.equal(f.r.flatRecovery.kind,'closed-fill-ledger');assert.equal(f.r.exits[0].cancelled,true);assert.equal(f.r.exits[0].confirmed,false);assert.equal(f.e.auto,true);
 assert.ok(f.calls.some(c=>c.path==='/fapi/v1/userTrades'&&c.p.orderId===10));assert.ok(f.calls.some(c=>c.path==='/fapi/v1/userTrades'&&c.p.fromId==='100'));assert.ok(f.calls.some(c=>c.path==='/fapi/v1/openOrders'&&c.p.symbol===symbol));assert.ok(f.calls.some(c=>c.path==='/fapi/v1/openAlgoOrders'&&c.p.symbol===symbol));
 const before=f.calls.length;await f.e.reconcile();assert.equal(f.calls.length,before);assert.equal(f.saved.at(-1).records[0].closedAt,f.r.closedAt);
});
test('the recovered record releases the entry hold and normal scanning continues when Auto was enabled',async()=>{
 const f=fixture();f.e.entryHold='Filled entry awaiting position confirmation; no new orders';let scans=0;f.e.scan=async()=>scans++;
 await f.e.tick();assert.ok(f.r.closedAt);assert.equal(f.e.auto,true);assert.equal(f.e.entryHold,'');assert.equal(scans,1);assert.equal(f.e.state.goalStopAt,undefined);
});
test('manual Stop stays stopped after reconciliation, while a later explicit Start can resume',async()=>{
 const f=fixture();f.e.pause('Manual Stop');let scans=0;f.e.scan=async()=>scans++;
 await f.e.tick();assert.ok(f.r.closedAt);assert.equal(f.e.auto,false);assert.equal(scans,0);
 await f.e.start();assert.equal(f.e.auto,true);assert.equal(f.e.active().length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('a zero-position screen with only entry fills is insufficient to forget the trade',async()=>{
 const f=fixture();f.trades.pop();await assert.rejects(()=>f.e.reconcile(),/closing fills are not confirmed/);assert.equal(f.r.closedAt,undefined);assert.equal(f.r.exits[0].confirmed,true);assert.equal(f.e.active().length,1);
 const reads=f.calls.filter(c=>c.path==='/fapi/v1/userTrades').length;await assert.rejects(()=>f.e.reconcile(),/closing fills are not confirmed/);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/userTrades').length,reads);
});
test('a position appearing on a fresh read remains owned and enters normal protection checks',async()=>{
 const f=fixture();f.positions=[{symbol,positionSide:'BOTH',positionAmt:'100',entryPrice:'1',markPrice:'1',unRealizedProfit:'0'}];let protectedCount=0;f.e.reconcileBandExits=async()=>protectedCount++;
 await f.e.reconcile();assert.equal(f.r.closedAt,undefined);assert.equal(f.r.observedOpen,true);assert.equal(protectedCount,1);assert.ok(!f.calls.some(c=>c.path==='/fapi/v1/userTrades'));
});
test('a position appearing after the fill-history read prevents stale closure and gets protected',async()=>{
 const f=fixture(),base=f.e.api.call;let positionReads=0,protectedCount=0;
 f.e.api.call=async(m,p,q)=>{if(p==='/fapi/v3/positionRisk'&&++positionReads===2)f.positions=[{symbol,positionSide:'BOTH',positionAmt:'100',entryPrice:'1',markPrice:'1',unRealizedProfit:'0'}];return base(m,p,q);};f.e.reconcileBandExits=async()=>protectedCount++;
 await f.e.reconcile();assert.equal(f.r.closedAt,undefined);assert.equal(f.r.observedOpen,true);assert.equal(protectedCount,1);
});
for(const field of ['orders','algos'])test('fresh open '+field+' prevent retirement even when historical fills balance',async()=>{
 const f=fixture();f[field]=[{symbol,orderId:999,clientAlgoId:'manual'}];await assert.rejects(()=>f.e.reconcile(),/still reports open orders/);assert.equal(f.r.closedAt,undefined);assert.equal(f.r.exits[0].cancelled,undefined);assert.equal(f.e.active().length,1);
});
for(const field of ['pendingClose','lossReduction'])test('an unresolved '+field+' is never discarded by missing-position recovery',async()=>{
 const f=fixture();f.r[field]=field==='pendingClose'?'bd1_close':{id:'bd1_reduce',status:'PENDING'};f.e.settleReduction=async()=>{};
 await assert.rejects(()=>f.e.reconcile(),/still needs reconciliation/);assert.equal(f.r.closedAt,undefined);assert.ok(f.r[field]);
});
test('incomplete, duplicated, wrong-direction and tiny-residual fill histories never prove closure',async()=>{
 const variants=[
  f=>f.trades[1].qty='99.999999999999999999',
  f=>f.trades[1].qty='101',
  f=>f.trades[1].side='BUY',
  f=>f.trades[1].positionSide='LONG',
  f=>f.trades[1].symbol='OTHERUSDT',
  f=>f.trades[1].id=f.trades[0].id,
  f=>f.trades[1].time=f.trades[0].time-1,
  f=>f.trades[0].qty='99',
  f=>f.order.clientOrderId='another-entry',
  f=>f.order.orderId=999,
  f=>f.order.executedQty='100.000000000000000001'
 ];
 for(const mutate of variants){const f=fixture();mutate(f);await assert.rejects(()=>f.e.reconcile());assert.equal(f.r.closedAt,undefined);assert.equal(f.r.exits[0].confirmed,true);}
});
test('matching entry fills and a closing fill across the 1000-row boundary are verified exactly',async()=>{
 const f=fixture();f.trades=Array.from({length:1000},(_,i)=>f.trade(100+i,10,'BUY','.1',f.r.at+i));f.trades.forEach(t=>t.qty='0.1');f.trades.push(f.trade(1100,11,'SELL','100',f.r.at+2000));
 await f.e.reconcile();assert.ok(f.r.closedAt);assert.equal(f.r.flatRecovery.tradeCount,1001);assert.deepEqual(f.calls.filter(c=>c.path==='/fapi/v1/userTrades'&&c.p.fromId).map(c=>c.p.fromId),['100','1100']);
});
for(const endpoint of ['/fapi/v1/userTrades','/fapi/v3/positionRisk','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'])test(endpoint+' read failure keeps the journal and protection intact',async()=>{
 const f=fixture(),base=f.e.api.call;f.e.api.call=async(m,p,q)=>{if(p===endpoint)throw new DemoError('Read unavailable',503);return base(m,p,q);};
 await assert.rejects(()=>f.e.reconcile(),/Read unavailable/);assert.equal(f.r.closedAt,undefined);assert.equal(f.r.exits[0].confirmed,true);
});
test('saving the recovered state must succeed before the record can leave the active journal',async()=>{
 const f=fixture();f.e.persist=()=>{throw Error('Disk unavailable');};await assert.rejects(()=>f.e.reconcile(),/Disk unavailable/);assert.equal(f.r.closedAt,undefined);assert.equal(f.r.exits[0].confirmed,true);assert.equal(f.e.active().length,1);
});
test('an already-closed record remains reconciled after a restart without deleting history',async()=>{
 const f=fixture();await f.e.reconcile();const restored=new DemoEngine(f.e.api,structuredClone(f.e.state),()=>{}),before=f.calls.length;await restored.reconcile();assert.equal(f.calls.length,before);assert.equal(restored.active().length,0);assert.equal(restored.state.records.length,1);assert.equal(restored.auto,false);
});
test('repeated pending-fill checks do not flood the stopped bot activity log',async()=>{
 const f=fixture();f.trades.pop();f.e.auto=false;await f.e.tick();const events=f.e.events.length;await f.e.tick();await f.e.tick();assert.equal(f.e.events.length,events);assert.match(f.e.events[0].text,/MEGAUSDT.*closing fills/);assert.equal(f.e.auto,false);
});
