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
    if(path==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000',marginBalance:'5000'}],positions:position?[{...position,unrealizedProfit:position.unRealizedProfit}]:[]};
    if(path==='/fapi/v3/positionRisk')return position?[position]:[];
    if(path==='/fapi/v1/openOrders')return [];
    if(path==='/fapi/v1/openAlgoOrders')return [...algos.values()].filter(x=>x.algoStatus==='NEW');
    if(path==='/fapi/v1/assetIndex')return [{symbol:'USDTUSD',index:'1',time:Date.now()}];
    if(path==='/fapi/v1/premiumIndex')return {markPrice:'100',time:Date.now()};
    if(path==='/fapi/v1/commissionRate')return {takerCommissionRate:'.0005'};
    if(path==='/fapi/v1/marginType')return {code:200};
    if(path==='/fapi/v1/leverage')return {leverage:3,maxNotionalValue:'1000000'};
    if(path==='/fapi/v1/income')return [];
    if(path==='/fapi/v1/order'){
      if(method==='GET'){if(!orders.has(p.origClientOrderId))throw new DemoError('not found',-2013);return orders.get(p.origClientOrderId);}
      if(method==='DELETE')return {status:'CANCELED'};
      if(failClose&&p.reduceOnly)throw new DemoError('unknown close',0,true);
      const o={orderId:orders.size+1,status:'FILLED',clientOrderId:p.newClientOrderId,avgPrice:'100',executedQty:p.quantity};orders.set(p.newClientOrderId,o);
      if(p.reduceOnly){assert.equal(p.reduceOnly,'true');position=null;}else{position={symbol,positionSide:'BOTH',positionAmt:p.side==='BUY'?p.quantity:String(-p.quantity),entryPrice:'100',markPrice:'100',unRealizedProfit:'0',positionInitialMargin:'100'};if(unknownEntry)throw new DemoError('timeout',0,true);}
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
 for(const side of ['BUY','SELL'])for(const target of [-9,10,40]){const p=+exitPrice(100,75,.0005,target,side,'.000001');const net=(p-100)*75*(side==='BUY'?1:-1)-(100+p)*75*.0005;assert(Math.abs(net-target)<.001);}
});
test('balance conversion requires fresh complete rates',()=>{
 const assets=[{asset:'USDT',marginBalance:'5000'},{asset:'USDC',marginBalance:'5000'},{asset:'BTC',marginBalance:'.01'}];const rates=[{symbol:'USDTUSD',index:1,time:now},{symbol:'USDCUSD',index:1,time:now},{symbol:'BTCUSD',index:76638.83,time:now}];
 assert.equal(combinedValue(assets,rates,now),10766.3883);assert.equal(combinedValue(assets,rates.slice(0,2),now),null);assert.equal(combinedValue(assets,rates,now+61000),null);
});
test('entry journals before POST, uses 3x, and installs exchange protection',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,1);assert(f.e.active()[0].protected);assert.equal(f.algos.size,2);
 const entry=f.calls.find(c=>c.path==='/fapi/v1/order'&&c.method==='POST');assert.equal(entry.p.quantity,'3.000');assert(f.saved.some(s=>s.records[0]?.id===entry.p.newClientOrderId&&!s.records[0].orderId));
 assert.equal(f.calls.find(c=>c.path==='/fapi/v1/leverage').p.leverage,3);assert.equal(f.calls.find(c=>c.path==='/fapi/v1/marginType').p.marginType,'ISOLATED');
 await f.e.enter(symbol,f.signal);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('timeout after accepted entry reconciles client ID without duplicate POST',async()=>{
 const f=fixture();f.unknownEntry=true;await f.e.enter(symbol,f.signal);assert(f.e.active()[0].protected);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('protective rejection stops auto and closes reduce-only',async()=>{
 const f=fixture();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.auto,false);assert.equal(f.position,null);assert(f.calls.some(c=>c.path==='/fapi/v1/order'&&c.p.reduceOnly==='true'));
});
test('profit floor is an additional exchange stop; manual close cleans protective orders',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position.markPrice='107.5';f.position.unRealizedProfit='22.5';await f.e.refresh();await f.e.reconcile();assert([...f.algos.values()].some(a=>a.clientAlgoId.endsWith('_floor')));assert.equal(f.algos.size,3);
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
test('balance connection survives a blocked trading-settings endpoint',async()=>{
 const f=fixture(),original=f.api.call;f.api.call=async(method,path,...args)=>{if(path==='/fapi/v1/positionSide/dual')throw new DemoError('GET /fapi/v1/positionSide/dual: blocked');return original(method,path,...args);};
 await f.e.initialize();assert.equal(f.calls[0].path,'/fapi/v3/account');assert.equal(f.e.connected,true);assert.equal(f.e.tradingReady,false);assert.equal(f.e.auto,false);assert.equal(f.e.account.assets[0].walletBalance,'5000');assert.match(f.e.block,/positionSide\/dual/);
 await f.e.tick();assert.equal(f.e.connected,true);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 await assert.rejects(()=>f.e.start());assert.equal(f.e.auto,false);
});
test('network errors identify the failing read endpoint and do not imply an order',async()=>{
 const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('fake'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const api=new DemoAPI('fake-key',key,async()=>{throw new TypeError('Failed to fetch')},webcrypto);api.synced=Date.now();
 await assert.rejects(()=>api.call('GET','/fapi/v1/positionSide/dual'),e=>e.message.includes('GET /fapi/v1/positionSide/dual')&&e.message.includes('did not submit an order')&&!e.uncertain);
});
test('default browser fetch is invoked without binding DemoAPI as its receiver',async()=>{
 const original=global.fetch;let invoked=false;
 global.fetch=function(url,options){'use strict';if(this instanceof DemoAPI)throw new TypeError('Illegal invocation');invoked=true;assert.equal(url,'https://demo-fapi.binance.com/fapi/v1/time');return Promise.resolve({ok:true,json:async()=>({serverTime:123})});};
 try{const api=new DemoAPI('fake',null);assert.deepEqual(await api.call('GET','/fapi/v1/time',{},false),{serverTime:123});assert(invoked);}finally{global.fetch=original;}
});
test('blocked all-market order request checks the complete contract list',async()=>{
 const f=fixture();f.e.orderUniverse=['BTCUSDT','ETHUSDT'];const seen=[];
 f.api.call=async(method,path,p={})=>{if(!p.symbol)throw new DemoError('CORS',0);seen.push(p.symbol);return p.symbol==='ETHUSDT'?[{symbol:'ETHUSDT',orderId:7}]:[];};
 const orders=await f.e.readOrderInventory('/fapi/v1/openOrders');assert.deepEqual(seen,['BTCUSDT','ETHUSDT']);assert.equal(orders[0].orderId,7);
});
test('failed symbol inventory never counts as an empty order list',async()=>{
 const f=fixture();f.e.orderUniverse=['BTCUSDT','ETHUSDT'];f.api.call=async(method,path,p={})=>{if(!p.symbol||p.symbol==='ETHUSDT')throw new DemoError('blocked',0);return [];};
 await assert.rejects(()=>f.e.readOrderInventory('/fapi/v1/openOrders'));assert.equal(f.e.inventoryCache['/fapi/v1/openOrders'],undefined);
});

test('long and short entries cap exposure at $300 and protect near $9 net loss',async()=>{
 for(const side of ['BUY','SELL']){
  const f=fixture();f.signal.side=side;if(side==='SELL')f.signal.low=101;
  await f.e.enter(symbol,f.signal);
  const sl=[...f.algos.values()].find(a=>a.type==='STOP_MARKET');
  const qty=Math.abs(Number(f.position.positionAmt)),price=Number(sl.triggerPrice);
  assert(qty*100<=300);
  const net=(price-100)*qty*(side==='BUY'?1:-1)-(100+price)*qty*.0005;
  assert(net>=-9-.000001&&net<=-8.8);
  f.position.unRealizedProfit='-9';await f.e.refresh();await f.e.reconcile();
  assert.equal(f.position,null);assert.match(f.e.state.records[0].closeReason,/\$9 loss threshold/);
  assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/leverage').length,1);
 }
});

test('reset reloads Binance balances, archives journal and clears session without orders',async()=>{
 const f=fixture();f.e.state.records.push({id:'bd1_old',symbol,side:'BUY',closedAt:Date.now(),exits:[]});
 f.e.state.startedAt=now;f.e.income=[{income:'-10'}];
 await f.e.resetFromBinance();
 assert.equal(f.e.balance,5000);assert.equal(f.e.state.records.length,0);assert.equal(f.e.state.archives[0].records.length,1);
 assert.equal(f.e.state.startedAt,0);assert.equal(f.e.sessionNet(),0);assert.equal(f.e.auto,false);
 assert(!f.calls.some(c=>c.method==='POST'||c.method==='DELETE'));
});
test('reset refuses open exchange positions and preserves journal',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);const old=f.e.state;
 await assert.rejects(()=>f.e.resetFromBinance(),/Reset blocked/);
 assert.equal(f.e.state,old);assert(f.position);assert.equal(f.e.auto,false);
});

test('backend rate limit is identified and cooldown blocks more requests',async()=>{
 const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('fake'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 let count=0;const api=new DemoAPI('fake',key,async()=>{count++;return {status:429,ok:false,headers:{get:()=>null},json:async()=>({error:'Backend rate limit; no request forwarded'})};},webcrypto);
 api.relayToken='fake-token';api.synced=Date.now();
 await assert.rejects(()=>api.call('GET','/fapi/v3/account'),/Local backend rate limit/);
 await assert.rejects(()=>api.call('GET','/fapi/v3/account'),/seconds remaining/);
 assert.equal(count,1);
});
test('local unauthorized token is not described as a Binance key failure',async()=>{
 const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('fake'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const api=new DemoAPI('fake',key,async()=>({status:401,ok:false,json:async()=>({error:'Backend access token rejected'})}),webcrypto);
 api.relayToken='fake-token';api.synced=Date.now();
 await assert.rejects(()=>api.call('GET','/fapi/v3/account'),/Local connection token rejected/);
});
test('external Binance close removes position and cancels sibling exits without another close order',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position=null;
 const before=f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order').length;
 await f.e.refresh();await f.e.reconcile();
 assert.equal(f.e.positions.length,0);assert.equal(f.e.active().length,0);
 assert([...f.algos.values()].every(a=>a.algoStatus==='CANCELED'));
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order').length,before);
});
test('fresh positions reach display before a slow or failed order inventory',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position=null;
 let published=false;f.e.notify=()=>{if(f.e.positionAt&&f.e.positions.length===0)published=true;};
 f.e.readOrderInventory=async()=>{assert(published);throw new DemoError('inventory temporarily unavailable');};
 await assert.rejects(()=>f.e.refresh());assert(published);assert.equal(f.e.positions.length,0);
});

test('$1000 budget excludes extra demo money, reserves $200 and tracks losses',()=>{
 const f=fixture();f.e.account={assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000',unrealizedProfit:'0'}]};
 f.e.state.budgetWalletBaseline=5000;
 assert.deepEqual(f.e.budgetStatus(),{equity:1000,reserved:0,free:800});
 f.e.positions=[{positionInitialMargin:'800'}];assert.equal(f.e.budgetStatus().free,0);
 f.e.account.assets[0].walletBalance='4900';assert.equal(f.e.budgetStatus().equity,900);
 f.e.positions=[];assert.equal(f.e.budgetStatus().free,700);
 f.e.account.assets[0].walletBalance='6000';assert.equal(f.e.budgetStatus().equity,1000);
 f.e.state.budgetWalletBaseline=1000;f.e.account.assets[0].walletBalance='1000';
 assert.equal(f.e.budgetStatus().free,800);
 f.e.account.assets[0].unrealizedProfit='-50';assert.equal(f.e.budgetStatus().free,750);
});
