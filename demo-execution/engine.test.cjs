const {test}=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {DemoAPI,DemoEngine,DemoError,rounded,breakout,exitPrice,combinedValue}=require('./engine.js');
const now=Date.now();
const symbol='BTCUSDT';
function fixture(){
  let position=null,orders=new Map(),algos=new Map(),calls=[],unknownEntry=false,failProtection=false,failClose=false;
  const api={offset:0,call:async(method,path,p={},signed=true)=>{
    calls.push({method,path,p,signed});
    if(path==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000',marginBalance:'5000'}]};
    if(path==='/fapi/v3/positionRisk')return position?[position]:[];
    if(path==='/fapi/v1/openOrders')return [];
    if(path==='/fapi/v1/openAlgoOrders')return [...algos.values()].filter(x=>x.algoStatus==='NEW');
    if(path==='/fapi/v1/assetIndex')return [{symbol:'USDTUSD',index:'1',time:Date.now()}];
    if(path==='/fapi/v1/premiumIndex')return {markPrice:'100',time:Date.now()};
    if(path==='/fapi/v1/commissionRate')return {takerCommissionRate:'.0005'};
    if(path==='/fapi/v1/marginType')return {code:200};
    if(path==='/fapi/v1/leverage')return {leverage:15,maxNotionalValue:'1000000'};
    if(path==='/fapi/v1/income')return [];
    if(path==='/fapi/v1/order'){
      if(method==='GET'){if(!orders.has(p.origClientOrderId))throw new DemoError('not found',-2013);return orders.get(p.origClientOrderId);}
      if(method==='DELETE')return {status:'CANCELED'};
      if(failClose&&p.reduceOnly)throw new DemoError('unknown close',0,true);
      const o={orderId:orders.size+1,status:'FILLED',clientOrderId:p.newClientOrderId,avgPrice:'100',executedQty:p.quantity};orders.set(p.newClientOrderId,o);
      if(p.reduceOnly){assert.equal(p.reduceOnly,'true');position=null;}else{position={symbol,positionSide:'BOTH',positionAmt:p.side==='BUY'?p.quantity:String(-p.quantity),entryPrice:'100',markPrice:'100',unRealizedProfit:'0',positionInitialMargin:'500'};if(unknownEntry)throw new DemoError('timeout',0,true);}
      return o;
    }
    if(path==='/fapi/v1/algoOrder'){
      if(method==='GET'){if(!algos.has(p.clientAlgoId))throw new DemoError('missing',-2013);return algos.get(p.clientAlgoId);}
      if(method==='DELETE'){if(!algos.has(p.clientAlgoId))throw new DemoError('missing',-2013);algos.get(p.clientAlgoId).algoStatus='CANCELED';return {};}
      if(failProtection)throw new DemoError('unsupported',-1111);
      assert.equal(p.closePosition,'true');assert.equal(p.reduceOnly,undefined);assert.equal(p.quantity,undefined);
      const a={...p,algoStatus:'NEW',algoId:algos.size+1};algos.set(p.clientAlgoId,a);return a;
    }
    throw Error('Unmocked '+method+' '+path);
  }};
  let saved=[];const e=new DemoEngine(api,null,s=>saved.push(JSON.parse(JSON.stringify(s))));
  e.meta.set(symbol,{orderTypes:['MARKET'],filters:[{filterType:'MARKET_LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]});e.metaAt=Date.now();e.connected=true;e.auto=true;e.state.startedAt=now-1000;
  const signal={side:'BUY',close:now-1000,price:100,high:99,low:90,atr:2};
  return {e,api,signal,calls,saved,orders,algos,get position(){return position},set position(p){position=p},set unknownEntry(v){unknownEntry=v},set failProtection(v){failProtection=v},set failClose(v){failClose=v}};
}
test('demo endpoint and signed request never contain raw secret; live URLs blocked',async()=>{
 const secret='fake-unit-test-secret';const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);let calls=[];
 const api=new DemoAPI('fake-api',key,async(url,opt)=>{calls.push({url,opt});return {ok:true,json:async()=>url.includes('/time')?{serverTime:Date.now()}:{orderId:1}};},webcrypto);
 await api.call('POST','/fapi/v1/order',{symbol:'BTCUSDT',side:'BUY',type:'MARKET',quantity:'0.001'});
 assert(calls.every(x=>x.url.startsWith('https://demo-fapi.binance.com/')));assert(!JSON.stringify(calls).includes(secret));assert(calls[1].opt.body.includes('signature='));assert.equal(calls[1].opt.redirect,'error');
 await assert.rejects(()=>api.call('POST','https://fapi.binance.com/fapi/v1/order',{}));await assert.rejects(()=>api.call('POST','/fapi/v1/multiAssetsMargin',{}));
 api.clear();await assert.rejects(()=>api.call('GET','/fapi/v3/account'));
});
test('rounding and long/short net exit prices',()=>{
 assert.equal(rounded(.123456,'.001'),'0.123');assert.equal(rounded(10.001,'.01',true),'10.01');
 for(const side of ['BUY','SELL'])for(const target of [-35,10,40]){const p=+exitPrice(100,75,.0005,target,side,'.000001');const net=(p-100)*75*(side==='BUY'?1:-1)-(100+p)*75*.0005;assert(Math.abs(net-target)<.001);}
});
test('balance conversion requires fresh complete rates',()=>{
 const assets=[{asset:'USDT',marginBalance:'5000'},{asset:'USDC',marginBalance:'5000'},{asset:'BTC',marginBalance:'.01'}];const rates=[{symbol:'USDTUSD',index:1,time:now},{symbol:'USDCUSD',index:1,time:now},{symbol:'BTCUSD',index:76638.83,time:now}];
 assert.equal(combinedValue(assets,rates,now),10766.3883);assert.equal(combinedValue(assets,rates.slice(0,2),now),null);assert.equal(combinedValue(assets,rates,now+61000),null);
});
test('entry journals before POST, uses 15x, and installs exchange protection',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,1);assert(f.e.active()[0].protected);assert.equal(f.algos.size,2);
 const entry=f.calls.find(c=>c.path==='/fapi/v1/order'&&c.method==='POST');assert.equal(entry.p.quantity,'75.000');assert(f.saved.some(s=>s.records[0]?.id===entry.p.newClientOrderId&&!s.records[0].orderId));
 assert.equal(f.calls.find(c=>c.path==='/fapi/v1/leverage').p.leverage,15);assert.equal(f.calls.find(c=>c.path==='/fapi/v1/marginType').p.marginType,'ISOLATED');
 await f.e.enter(symbol,f.signal);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('timeout after accepted entry reconciles client ID without duplicate POST',async()=>{
 const f=fixture();f.unknownEntry=true;await f.e.enter(symbol,f.signal);assert(f.e.active()[0].protected);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('protective rejection stops auto and closes reduce-only',async()=>{
 const f=fixture();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.auto,false);assert.equal(f.position,null);assert(f.calls.some(c=>c.path==='/fapi/v1/order'&&c.p.reduceOnly==='true'));
});
test('profit floor is an additional exchange stop; manual close cleans protective orders',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position.markPrice='100.3';f.position.unRealizedProfit='22.5';await f.e.refresh();await f.e.reconcile();assert([...f.algos.values()].some(a=>a.clientAlgoId.endsWith('_floor')));assert.equal(f.algos.size,3);
 await f.e.close(symbol);assert.equal(f.position,null);assert.equal(f.e.active().length,0);assert([...f.algos.values()].every(a=>a.algoStatus==='CANCELED'));
});
test('Stop Auto during configuration prevents entry dispatch',async()=>{
 const f=fixture(),base=f.api.call;f.api.call=async(...args)=>{const r=await base(...args);if(args[1]==='/fapi/v1/leverage')f.e.pause();return r;};await f.e.enter(symbol,f.signal);assert(!f.calls.some(c=>c.path==='/fapi/v1/order'&&c.method==='POST'));
});
test('reload reconciles saved order and exits, does not submit another entry',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);const restored=new DemoEngine(f.api,JSON.parse(JSON.stringify(f.e.state)),()=>{});await restored.refresh();await restored.reconcile();assert(restored.active()[0].protected);assert.equal(restored.auto,false);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST').length,1);
});
test('unresolved entry without position blocks rather than resubmitting',async()=>{
 const f=fixture();f.e.state.records.push({id:'bd1_test',symbol,side:'BUY',exits:[],at:now});await f.e.refresh();await assert.rejects(()=>f.e.reconcile());assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('session goal accounts for commissions and funding',()=>{
 const f=fixture();f.e.income=[{income:'110'},{income:'-5'},{income:'-1'}];f.e.positions=[{symbol:'BTCUSDT',unRealizedProfit:'-2'}];assert.equal(f.e.sessionNet(),102);
});
test('only CLOSED complete candles can trigger a breakout',()=>{
 const base=Math.floor(now/300000)*300000;const bars=Array.from({length:22},(_,i)=>{const t=base-(22-i)*300000;return [t,95,100,90,i===21?101:95,20,t+299999]});bars[21][2]=102;
 assert.equal(breakout(bars,now).side,'BUY');const broken=structuredClone(bars);broken[10][0]+=1;assert.throws(()=>breakout(broken,now));assert.equal(breakout(bars,now+600000),null);
});
test('delayed position visibility keeps filled entry unresolved and protections intact',async()=>{
 const f=fixture();const original=f.api.call;f.api.call=async(method,path,p,signed)=>path==='/fapi/v3/positionRisk'?[]:original(method,path,p,signed);
 await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.active().length,1);assert.equal(f.algos.size,2);assert([...f.algos.values()].every(a=>a.algoStatus==='NEW'));
});
test('failed emergency close retains position in recoverable journal',async()=>{
 const f=fixture();f.failProtection=true;f.failClose=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.auto,false);assert.equal(f.e.active().length,1);assert(f.e.active()[0].pendingClose);assert(f.position);
 const count=f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST').length;await f.e.refresh();await assert.rejects(()=>f.e.reconcile());assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST').length,count);
});
test('user pause leaves exchange protective orders in place',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.e.pause();assert.equal(f.e.auto,false);assert(f.position);assert([...f.algos.values()].every(a=>a.algoStatus==='NEW'));
});
test('exchange-filled stop cancels sibling protection before symbol can reopen',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position=null;await f.e.refresh();await f.e.reconcile();assert.equal(f.e.active().length,0);assert([...f.algos.values()].every(a=>a.algoStatus==='CANCELED'));await f.e.enter(symbol,f.signal);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST').length,1);
});
test('income request follows every page and excludes transfers',async()=>{
 const f=fixture(),original=f.api.call;let pages=[];f.api.call=async(method,path,p)=>{if(path!=='/fapi/v1/income')return original(method,path,p);pages.push(p.page);return p.page===1?Array.from({length:1000},()=>({incomeType:'TRANSFER',asset:'USDT',income:100})): [{incomeType:'REALIZED_PNL',asset:'USDT',income:10},{incomeType:'COMMISSION',asset:'USDT',income:-1}];};await f.e.updateIncome();assert.deepEqual(pages,[1,2]);assert.equal(f.e.sessionNet(),9);
});
