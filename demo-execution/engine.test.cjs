const {test}=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {DemoAPI,DemoEngine,DemoError,rounded,breakout,qualifySetup,exitPrice,combinedValue}=require('./engine.js');
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
    if(path==='/fapi/v1/leverage')return {leverage:p.leverage,maxNotionalValue:'1000000'};
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
  let saved=[];const e=new DemoEngine(api,null,s=>saved.push(JSON.parse(JSON.stringify(s))));e.newRules=false;e.overrideUntil=0;e.experimentUntil=0;
  e.meta.set(symbol,{orderTypes:['MARKET'],filters:[{filterType:'MARKET_LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]});e.metaAt=Date.now();e.connected=true;e.auto=true;e.state.startedAt=now-1000;
  const signal={qualityConfirmed:true,strength:2,leverage:3,stopDistance:3,side:'BUY',close:now-1000,price:100,high:99,low:90,atr:2};
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
test('entry journals before POST, uses selected leverage, and installs exchange protection',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,1);assert(f.e.active()[0].protected);assert.equal(f.algos.size,2);
 const entry=f.calls.find(c=>c.path==='/fapi/v1/order'&&c.method==='POST');assert.equal(entry.p.quantity,'2.901');assert(f.saved.some(s=>s.records[0]?.id===entry.p.newClientOrderId&&!s.records[0].orderId));
 assert.equal(f.calls.find(c=>c.path==='/fapi/v1/leverage').p.leverage,3);assert.equal(f.calls.find(c=>c.path==='/fapi/v1/marginType').p.marginType,'CROSSED');
 await f.e.enter(symbol,f.signal);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('timeout after accepted entry reconciles client ID without duplicate POST',async()=>{
 const f=fixture();f.unknownEntry=true;await f.e.enter(symbol,f.signal);assert(f.e.active()[0].protected);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('protective rejection stops auto and closes reduce-only',async()=>{
 const f=fixture();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.auto,false);assert.equal(f.position,null);assert(f.calls.some(c=>c.path==='/fapi/v1/order'&&c.p.reduceOnly==='true'));
});
test('profit floor is an additional exchange stop; manual close cleans protective orders',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);f.position.markPrice='108';f.position.unRealizedProfit='22.5';await f.e.refresh();await f.e.reconcile();assert([...f.algos.values()].some(a=>a.clientAlgoId.endsWith('_floor')));assert.equal(f.algos.size,3);
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

test('long and short entries cap exposure by volatility and protect near $9 net loss and protect near $9 net loss',async()=>{
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
test('trend and volume confirmation reject weak signals; stronger rule agreement selects more leverage',()=>{
 const end=Math.floor(now/3600000)*3600000;
 const hourly=Array.from({length:60},(_,i)=>[end-(60-i)*3600000,0,0,0,100+i,10,end-(59-i)*3600000-1]);
 const base=Math.floor(now/300000)*300000;
 const bars=Array.from({length:21},(_,i)=>[base-(21-i)*300000,100,102,99,101,10,base-(20-i)*300000-1]);
 const signal={side:'BUY',atr:3};bars[20][1]=100;bars[20][2]=104;bars[20][3]=100;bars[20][4]=103.2;bars[20][5]=16;
 assert.equal(qualifySetup(signal,bars,hourly,now).leverage,3);
 bars[20][5]=22;assert.equal(qualifySetup(signal,bars,hourly,now).leverage,5);
 bars[20][4]=103.8;assert.equal(qualifySetup(signal,bars,hourly,now).leverage,8);
 bars[20][5]=10;assert.equal(qualifySetup(signal,bars,hourly,now),null);
 bars[20][5]=22;assert.equal(qualifySetup({...signal,side:'SELL'},bars,hourly,now),null);
 assert.equal(qualifySetup(signal,bars,hourly,now+7200000),null);
});
test('unconfirmed setup cannot submit an entry',async()=>{
 const f=fixture();delete f.signal.qualityConfirmed;await f.e.enter(symbol,f.signal);assert.equal(f.calls.length,0);
});
test('higher leverage remains limited by volatility risk sizing',async()=>{
 for(const leverage of [3,5,8]){
 const f=fixture();f.signal.leverage=leverage;f.signal.stopDistance=5;await f.e.enter(symbol,f.signal);
 const entry=f.calls.find(c=>c.method==='POST'&&c.path==='/fapi/v1/order');const qty=Number(entry.p.quantity);
 assert(qty*(5+.0005*205)<=9);assert(qty*100<=100*leverage);
 assert.equal(f.calls.find(c=>c.path==='/fapi/v1/leverage').p.leverage,leverage);
 }
});

test('existing position is not converted to Cross or given another entry',async()=>{
 const f=fixture();f.position={symbol,positionSide:'BOTH',positionAmt:'1',entryPrice:'100',markPrice:'100',unRealizedProfit:'0',positionInitialMargin:'100',marginType:'isolated'};
 await f.e.enter(symbol,f.signal);
 assert(!f.calls.some(c=>c.method==='POST'));assert.equal(f.position.marginType,'isolated');
});

test('scanner rotates bounded batches and explains WAIT without submitting orders',async()=>{
  const calls=[];
  const api={offset:0,call:async(method,path,p)=>{calls.push(p.symbol);assert.equal(path,'/fapi/v1/klines');return [];}};
  const e=new DemoEngine(api);e.experimentUntil=0;e.auto=true;e.symbols=Array.from({length:25},(_,i)=>'COIN'+i);
  await e.scan();assert.equal(calls.length,12);assert.equal(e.scanChecked,12);
  await e.scan();assert.equal(calls.length,24);assert.equal(new Set(calls).size,24);
  assert.ok(e.scanned.every(s=>s.side==='WAIT'&&s.reason==='No qualifying closed 1–5m / 10m / 15m / 20m / 30m / 60m setup'));
  e.auto=false;await e.scan();assert.equal(calls.length,24);
});
test('scanner handles an empty universe without requests',async()=>{
  const e=new DemoEngine({call:async()=>assert.fail('Unexpected request')});e.auto=true;await e.scan();
});
test('minute policy has only SL, closes losing after 60s and leaves profit for manual close',async()=>{
  const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';f.signal.intervalMs=60000;
  await f.e.enter(symbol,f.signal);
  const r=f.e.active()[0];
  assert.deepEqual(r.exits.map(x=>x.kind),['sl']);
  r.openedAt=Date.now()-59000;await f.e.reconcile();assert.equal(f.e.active().length,1);
  r.openedAt=Date.now()-61000;f.position.unRealizedProfit='0.8';f.position.markPrice='100';
  await f.e.reconcile();assert.equal(f.e.active().length,1);assert.deepEqual(r.exits.map(x=>x.kind),['sl']);
  f.position.unRealizedProfit='-1';f.position.markPrice='99.7';await f.e.reconcile();
  assert.equal(f.e.active().length,1);r.lossSince=Date.now()-61000;await f.e.reconcile();
  assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'Estimated net loss persisted for 60 seconds');
});
test('minute policy enforces $5 loss before 60 seconds',async()=>{
  const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
  const r=f.e.active()[0];f.position.unRealizedProfit='-5';await f.e.reconcile();
  assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'$5 loss threshold');
});
test('one minute breakout accepts 1m candles and rejects 5m spacing',()=>{
  const end=Math.floor(Date.now()/60000)*60000-1;
  const bars=Array.from({length:22},(_,i)=>[end-(21-i)*60000-59999,'100','101','99',i===21?'102':'100','100',end-(21-i)*60000]);
  bars[21][2]='103';
  assert.equal(breakout(bars,end+1000,60000).side,'BUY');
  assert.throws(()=>breakout(bars,end+1000),/candles/);
  assert.equal(breakout(bars,end+76000,60000),null);
});
test('new minute BUY and SELL entries install a fee-adjusted $5 stop',async()=>{
 for(const side of ['BUY','SELL']){
  const f=fixture();Object.assign(f.signal,{side,exitPolicy:'manual-profit-60s-loss',high:99,low:101});
  await f.e.enter(symbol,f.signal);const r=f.e.active()[0];assert.equal(r.lossLimit,5);
  const sl=r.exits.find(x=>x.kind==='sl');const q=r.filledQty,p=Number(sl.triggerPrice),sign=side==='BUY'?1:-1;
  const net=sign*(p-r.entry)*q-r.fee*q*(r.entry+p);
  assert.ok(Math.abs(net+5)<.05);assert.equal(r.exits.length,1);
 }
});
test('three existing records do not impose a count limit on a new entry',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';
 f.e.active=()=>[{},{},{}];f.e.reconcile=async()=>{};
 await f.e.enter(symbol,f.signal);
 assert.ok(f.calls.some(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly));
});
test('continuation review supports both directions and never sends orders',async()=>{
 for(const side of ['BUY','SELL']){
  const r={id:'bd1_test',symbol:'BTCUSDT',side,exitPolicy:'manual-profit-60s-loss',netEstimate:2,exits:[]};
  const api={offset:0,call:async(method,path,p)=>{
   assert.equal(method,'GET');assert.equal(path,'/fapi/v1/klines');
   const ms=p.interval==='1m'?60000:300000,end=Math.floor(Date.now()/ms)*ms-1;
   return Array.from({length:25},(_,i)=>{const v=side==='BUY'?100+i:150-i;return [end-(24-i)*ms-ms+1,v,v+1,v-1,v,100,end-(24-i)*ms];});
  }};
  const e=new DemoEngine(api,{version:1,records:[r]},()=>{},()=>{});await e.reviewContinuation();
  assert.match(r.continuation,/support this direction/);assert.ok(r.reviewAt);
 }
});
test('failed advisory review leaves positions and protection untouched',async()=>{
 const r={id:'bd1_test',symbol:'BTCUSDT',side:'BUY',exitPolicy:'manual-profit-60s-loss',netEstimate:2,exits:[]};
 const e=new DemoEngine({offset:0,call:async()=>{throw Error('Offline');}},{version:1,records:[r]},()=>{},()=>{});
 await e.reviewContinuation();assert.match(r.continuation,/unavailable/);assert.equal(r.closedAt,undefined);
});
test('scanner wraps to checked markets and keeps one latest row per coin',async()=>{
 const calls=[],e=new DemoEngine({offset:0,call:async(m,p,q)=>{calls.push(q.symbol);return [];}});
 e.experimentUntil=0;e.auto=true;e.symbols=['AUSDT','BUSDT','CUSDT'];await e.scan();await e.scan();
 assert.deepEqual(calls,['AUSDT','BUSDT','CUSDT','AUSDT','BUSDT','CUSDT']);
 assert.equal(e.scanned.length,3);assert.equal(e.scanChecked,6);
});
test('recent candidate is rechecked before cursor reaches it without starving the full scan',async()=>{
 const calls=[],e=new DemoEngine({offset:0,call:async(m,p,q)=>{calls.push(q.symbol);return [];}});
 e.experimentUntil=0;e.auto=true;e.symbols=Array.from({length:40},(_,i)=>'C'+i+'USDT');e.cursor=15;
 e.rechecks=new Map([['C0USDT',{seen:Date.now(),checked:Date.now()-31000}]]);
 await e.scan();assert.equal(calls[0],'C0USDT');assert.equal(calls.length,13);assert.equal(e.cursor,27);
});
test('a qualifying signal reports why execution was skipped',async()=>{
 const f=fixture();f.signal.price=90;await f.e.enter(symbol,f.signal);
 assert.equal(f.e.entryOutcome,'Price moved too far or breakout reversed');
 assert.equal(f.calls.some(c=>c.method==='POST'&&c.path==='/fapi/v1/order'),false);
});
test('two-minute fallback aggregates complete aligned pairs and excludes unfinished pairs',()=>{
 const {twoMinuteBars}=require('./engine.js');
 const t=Math.floor(Date.now()/120000)*120000-240000;
 const bars=Array.from({length:5},(_,i)=>[t+i*60000,100+i,103+i,99+i,102+i,10+i,t+(i+1)*60000-1]);
 const paired=twoMinuteBars(bars,t+240000);
 assert.equal(paired.length,2);assert.deepEqual(paired[0],[t,100,104,99,103,21,t+119999]);
 assert.equal(twoMinuteBars(bars.slice(1),t+240000).length,1);
 const broken=bars.slice();broken[1]=[...broken[1]];broken[1][0]+=100;
 assert.throws(()=>twoMinuteBars(broken,t+240000),/candles/);
});
test('qualified entry reports progress through submission',async()=>{
 const f=fixture(),seen=[];f.e.scanned=[{symbol,reason:''}];f.e.notify=()=>seen.push(f.e.scanned[0].reason);
 await f.e.enter(symbol,f.signal);
 assert.ok(seen.includes('Checking Binance balance, positions and open orders'));
 assert.ok(seen.includes('Checking commission and position size'));
 assert.ok(seen.includes('Submitting demo order'));
});
test('loss timer resets on recovery and restarts on a later loss regardless of trade age',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0];r.openedAt=Date.now()-3600000;
 r.lossSince=Date.now()-59000;f.position.unRealizedProfit='0.8';await f.e.reconcile();
 assert.equal(r.lossSince,null);assert.equal(f.e.active().length,1);
 f.position.unRealizedProfit='-1';await f.e.reconcile();
 assert.ok(Date.now()-r.lossSince<1000);assert.equal(f.e.active().length,1);
 r.lossSince=Date.now()-59000;await f.e.reconcile();assert.equal(f.e.active().length,1);
 r.lossSince=Date.now()-60001;await f.e.reconcile();assert.equal(f.e.active().length,0);
});
test('net break-even resets the loss timer',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0];r.lossSince=Date.now()-61000;
 f.position.unRealizedProfit=String(r.fee*r.filledQty*(r.entry+Number(f.position.markPrice)));
 await f.e.reconcile();assert.equal(r.lossSince,null);assert.equal(f.e.active().length,1);
});
test('profit ladder arms strictly above $4 and doubles',()=>{
 const {profitFloor}=require('./engine.js');
 for(const [peak,floor] of [[.5,null],[1,null],[2,null],[3,null],[4,null],[4.01,4],[5,4],[8,4],[8.01,8],[16,8],[16.01,16],[32,16],[32.01,32]])assert.equal(profitFloor(peak),floor);
});
test('BUY and SELL remove old small floors, allow small profits, and close on doubled pullback',async()=>{
 for(const side of ['BUY','SELL']){
  const f=fixture();Object.assign(f.signal,{side,exitPolicy:'manual-profit-60s-loss',low:101,high:99});
  await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
  const setNet=n=>{f.position.unRealizedProfit=String(n+r.fee*r.filledQty*(r.entry+Number(f.position.markPrice)));};
  r.peak=2;r.profitFloor=1;
  for(const n of [.5,1,2,3,4]){setNet(n);await f.e.reconcile();assert.equal(r.profitFloor,null);assert.equal(f.e.active().length,1);}
  for(const [n,floor] of [[5,4],[4.5,4],[9,8],[8.5,8],[17,16],[16.5,16]]){setNet(n);await f.e.reconcile();assert.equal(r.profitFloor,floor);assert.equal(f.e.active().length,1);}
  setNet(15.99);await f.e.reconcile();assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'Profit pullback to $16.00 floor');
 }
});
test('five dollar peak closes on return to four dollars',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 const fees=r.fee*r.filledQty*(r.entry+Number(f.position.markPrice));
 f.position.unRealizedProfit=String(5+fees);await f.e.reconcile();assert.equal(r.profitFloor,4);
 f.position.unRealizedProfit=String(4+fees);await f.e.reconcile();assert.equal(f.e.active().length,0);
});
test('50x override expires at its absolute deadline and retains $5 risk sizing',async()=>{
 const f=fixture();f.e.overrideUntil=Date.now()+3600000;f.signal.exitPolicy='manual-profit-60s-loss';
 assert.equal(f.e.entryLeverage(f.signal,f.e.overrideUntil-1),50);
 assert.equal(f.e.entryLeverage(f.signal,f.e.overrideUntil),3);
 await f.e.enter(symbol,f.signal);
 assert.equal(f.calls.find(c=>c.path==='/fapi/v1/leverage').p.leverage,50);
 const r=f.e.active()[0];assert.equal(r.leverage,50);assert.equal(r.lossLimit,5);
 assert.ok(r.filledQty*(f.signal.stopDistance+r.fee*(200+f.signal.stopDistance))<=5);
});
test('expiry during leverage setup prevents a new 50x order',async()=>{
 const f=fixture();f.e.overrideUntil=Date.now()+3600000;
 const original=f.api.call;f.api.call=async(m,p,q,s)=>{const r=await original(m,p,q,s);if(p==='/fapi/v1/leverage')f.e.overrideUntil=0;f.e.experimentUntil=0;return r;};
 await f.e.enter(symbol,f.signal);assert.equal(f.calls.some(c=>c.path==='/fapi/v1/order'&&c.method==='POST'),false);
 assert.match(f.e.entryOutcome,/window expired/);
});
test('experiment uses available USDT, 50x, and holds losses without automatic exits until expiry',async()=>{
 const f=fixture();f.e.experimentUntil=f.e.overrideUntil=Date.now()+3600000;
 Object.assign(f.signal,{experimental:true,exitPolicy:'manual-profit-60s-loss'});
 f.e.budgetStatus=()=>({free:0,equity:0,reserved:800});f.e.state.goal=true;
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.ok(r);assert.equal(r.leverage,50);assert.equal(r.exits.length,0);assert.equal(r.protected,false);
 f.position.unRealizedProfit='-100';f.position.markPrice='98';await f.e.reconcile();
 assert.equal(f.e.active().length,1);assert.equal(r.exits.length,0);
 r.experimentUntil=Date.now()-1;await f.e.reconcile();
 assert.equal(f.e.active().length,0);
});
test('experiment does not remove existing position protection',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0];f.e.experimentUntil=Date.now()+3600000;
 await f.e.reconcile();assert.equal(r.exits.length,1);assert.equal(r.protected,true);
});
test('experiment expiry restores an exchange stop on a profitable held position',async()=>{
 const f=fixture();f.e.experimentUntil=f.e.overrideUntil=Date.now()+3600000;
 Object.assign(f.signal,{experimental:true,exitPolicy:'manual-profit-60s-loss'});
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.position.markPrice='101';f.position.unRealizedProfit='50';r.experimentUntil=Date.now()-1;
 await f.e.reconcile();assert.equal(r.protected,true);assert.equal(r.exits[0].kind,'sl');
});
test('experiment signals follow fresh closed candle direction, not unfinished candles',()=>{
 const {experimentSignal}=require('./engine.js');
 const end=Math.floor(Date.now()/60000)*60000-1;
 const bars=Array.from({length:22},(_,i)=>[end-(21-i)*60000-59999,100,102,98,101,100,end-(21-i)*60000]);
 assert.equal(experimentSignal(bars,end+1).side,'BUY');
 bars[21][4]=99;assert.equal(experimentSignal(bars,end+1).side,'SELL');
 assert.equal(experimentSignal(bars,end+76000),null);
 bars[21][4]=100;assert.equal(experimentSignal(bars,end+1),null);
});
test('entry quantity is reduced below reported leverage notional cap',async()=>{
 const f=fixture();f.e.experimentUntil=f.e.overrideUntil=Date.now()+3600000;
 Object.assign(f.signal,{experimental:true,exitPolicy:'manual-profit-60s-loss'});
 const original=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverage'?{leverage:q.leverage,maxNotionalValue:'1000'}:original(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.ok(Number(r.quantity)*100<=950);assert.equal(r.leverage,50);assert.equal(f.e.auto,true);
});
test('definitive -2027 entry rejection is recorded without stopping or retrying',async()=>{
 const f=fixture();const original=f.api.call;let submissions=0;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'){submissions++;throw new DemoError('Leverage cap',-2027,false);}return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);
 assert.equal(submissions,1);assert.equal(f.e.active().length,0);assert.equal(f.e.state.records[0].rejected,true);assert.equal(f.e.auto,true);
 assert.match(f.e.entryOutcome,/continuing other coins/);
});
test('uncertain -2027 response still stops for reconciliation',async()=>{
 const f=fixture();const original=f.api.call;let submissions=0;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'){submissions++;throw new DemoError('Uncertain response',-2027,true);}return original(m,p,q,s);};
 await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(submissions,1);assert.equal(f.e.auto,false);
});
test('fresh rules disable experiment and use flexible margin at 50x and an $8 stop',async()=>{
 const f=fixture();f.e.newRules=true;f.e.experimentUntil=f.e.overrideUntil=Date.now()+3600000;
 f.e.state.goal=true;f.e.budgetStatus=()=>({free:0,reserved:800,equity:0});
 f.signal.exitPolicy='manual-profit-60s-loss';
 assert.equal(f.e.experimentActive(),false);assert.equal(f.e.entryLeverage(f.signal),50);
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.rulesVersion,3);assert.equal(r.lossLimit,8);assert.equal(r.exits[0].kind,'sl8');
 assert.ok(r.filledQty*100/50<100);
 f.position.unRealizedProfit='-8';await f.e.reconcile();assert.equal(f.e.active().length,0);
});
test('existing bot exits migrate only after replacement $8 stop is accepted',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0],oldId=r.exits[0].id;f.e.newRules=true;
 const offset=f.calls.length;await f.e.reconcile();const calls=f.calls.slice(offset);
 const added=calls.findIndex(c=>c.method==='POST'&&c.path==='/fapi/v1/algoOrder'&&c.p.clientAlgoId.endsWith('_sl8'));
 const removed=calls.findIndex(c=>c.method==='DELETE'&&c.p.clientAlgoId===oldId);
 assert.ok(added>=0&&removed>added);assert.equal(r.rulesVersion,3);assert.equal(r.lossLimit,8);assert.equal(r.protected,true);
});
test('fresh daily target rolls at Dubai midnight without deleting positions',()=>{
 const f=fixture();f.e.newRules=true;const records=f.e.state.records;
 f.e.syncDaily();const day=f.e.state.dayStart;
 assert.equal((day+14400000)%86400000,0);f.e.state.goal=true;
 f.api.offset+=86400000;f.e.syncDaily();
 assert.equal(f.e.state.dayStart,day+86400000);assert.equal(f.e.state.goal,false);assert.equal(f.e.state.records,records);
});
test('3m aggregation requires complete aligned closed candles',()=>{
 const {aggregateMinutes}=require('./engine.js');const t=Math.floor(Date.now()/180000)*180000-1800000;
 const raw=Array.from({length:90},(_,i)=>[t+i*60000,100,102,99,101,10,t+(i+1)*60000-1]);
 const result=aggregateMinutes(raw,t+5400000,3);
 assert.equal(result.length,30);assert.equal(result[0][5],30);assert.equal(result[0][6]-result[0][0],179999);
 assert.equal(aggregateMinutes(raw,t+179999,3).length,0);
});
test('fresh daily P&L offsets carried open P&L and retains realized income',()=>{
 const f=fixture();f.e.newRules=true;f.e.state.dayOpenPnl=10;
 f.e.income=[{income:'3'}];f.e.positions=[{symbol,unRealizedProfit:'12'}];
 assert.equal(f.e.sessionNet(),5);
});
test('Stop during Start cannot be overwritten when initialization finishes',async()=>{
 const f=fixture();f.e.newRules=true;f.e.tradingReady=false;
 f.e.prepareTrading=async()=>{f.e.pause('Stopped by user');f.e.tradingReady=true;};
 await f.e.start();assert.equal(f.e.auto,false);
});
test('queued Start is cancelled by Stop while a refresh is busy',async()=>{
 const f=fixture();f.e.busy=true;let started=false;
 const queued=f.e.control(async()=>{started=true;},'start');
 f.e.pause();await queued;assert.equal(started,false);assert.equal(f.e.controlPending,false);
});
test('manual sync waits for busy work and executes once without overlapping',async()=>{
 const f=fixture();f.e.busy=true;let count=0;
 const queued=f.e.control(async()=>{assert.equal(f.e.busy,true);count++;});
 assert.equal(await f.e.control(async()=>count++),false);
 f.e.busy=false;await queued;assert.equal(count,1);assert.equal(f.e.busy,false);
});
test('new inventory fallback checks tracked symbols rather than all 500 markets',async()=>{
 const f=fixture();f.e.newRules=true;f.e.orderUniverse=Array.from({length:507},(_,i)=>'COIN'+i+'USDT');
 f.e.positions=[{symbol,positionAmt:'1'}];const seen=[];
 f.api.call=async(m,p,q={})=>{if(!q.symbol)throw new DemoError('Unavailable all-market route',0);seen.push(q.symbol);return [];};
 await f.e.readOrderInventory('/fapi/v1/openOrders');
 assert.deepEqual(seen,[symbol]);assert.equal(f.e.scopedOrders,true);
});
test('new combined balance publishes before order inventory and refreshes after asset reset',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v3/account'?{assets:[{asset:'USDT',walletBalance:'6000',availableBalance:'6000',marginBalance:'6000'}],positions:[]}:original(m,p,q,s);
 f.e.balance=1;f.e.readOrderInventory=async()=>{assert.equal(f.e.balance,6000);return [];};
 await f.e.refresh();assert.equal(f.e.account.assets[0].walletBalance,'6000');
});
test('Binance-reset missing entry history reconciles a previously observed flat position',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.e.newRules=true;f.position=null;f.orders.clear();f.algos.clear();await f.e.refresh();await f.e.reconcile();
 assert.equal(f.e.active().length,0);assert.match(r.closeReason,/historical entry/);
});
test('4m aggregation excludes incomplete groups',()=>{
 const {aggregateMinutes}=require('./engine.js'),t=Math.floor(Date.now()/240000)*240000-6000000;
 const raw=Array.from({length:99},(_,i)=>[t+i*60000,100,102,99,101,10,t+(i+1)*60000-1]);
 const result=aggregateMinutes(raw,t+99*60000,4);
 assert.ok(result.every(b=>b[6]-b[0]===239999));assert.equal(result.length,24);
});
test('insufficient-margin definite entry rejection keeps scanning enabled',async()=>{
 const f=fixture(),original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order')throw new DemoError('Margin',-2019);return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.auto,true);assert.equal(f.e.active().length,0);
});
test('50x new entry retains $8 stop and uses flexible margin',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.leverage,50);assert.equal(r.lossLimit,8);assert.equal(r.protected,true);
 assert.ok(Number(r.quantity)*100/50<100);
});
for(const [path,code] of [['/fapi/v1/marginType',-4067],['/fapi/v1/leverage',-4028],['/fapi/v1/commissionRate',-1000],['/fapi/v1/order',-2010],['/fapi/v1/order',-1111]])test('recoverable rejection '+path+' '+code+' preserves auto',async()=>{
 const f=fixture(),original=f.api.call;f.e.newRules=true;
 f.api.call=async(m,p,q,s)=>{if(p===path&&(path!=='/fapi/v1/order'||m==='POST'))throw new DemoError('Test rejection',code);return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.auto,true);assert.equal(f.e.active().length,0);
});
test('authorization rejection remains actionable rather than silently skipped',async()=>{
 const f=fixture(),original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/commissionRate')throw new DemoError('Key rejected',-2015);return original(m,p,q,s);};
 await assert.rejects(()=>f.e.enter(symbol,f.signal),/Key rejected/);
});
test('current demo rules ignore old loss timer and still close at $8',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 const fees=r.fee*r.filledQty*(r.entry+Number(f.position.markPrice));
 r.lossSince=Date.now()-3600000;f.position.unRealizedProfit=String(-2+fees);
 await f.e.reconcile();assert.equal(f.e.active().length,1);assert.equal(r.lossSince,null);
 f.position.unRealizedProfit=String(-8.01+fees);await f.e.reconcile();assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'$8 loss threshold');
});
test('50x rejection falls back to accepted 20x and submits one risk-sized order',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';const original=f.api.call,attempts=[];
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverage'){attempts.push(q.leverage);if(q.leverage>20)throw new DemoError('Unsupported leverage',-4028);}return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.deepEqual(attempts,[50,25,20]);const r=f.e.active()[0];assert.equal(r.leverage,20);assert.equal(r.lossLimit,8);assert.equal(r.protected,true);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly).length,1);
 assert.ok(Number(r.quantity)*100/20<=100);
});
test('profit floors advance in five-dollar steps after 32',()=>{
 const {profitFloor}=require('./engine.js');
 for(const [peak,floor] of [[32,16],[32.01,32],[37,32],[37.01,37],[42,37],[42.01,42],[48,47],[100,97]])assert.equal(profitFloor(peak),floor);
});
test('income breakdown separates winning PnL, losses, commission and funding',()=>{
 const f=fixture();f.e.income=[{incomeType:'REALIZED_PNL',income:'12'},{incomeType:'REALIZED_PNL',income:'-8'},{incomeType:'COMMISSION',income:'-5'},{incomeType:'FUNDING_FEE',income:'-.5'}];
 assert.deepEqual(f.e.incomeBreakdown(),{gains:12,losses:-8,realized:4,commission:-5,funding:-.5,net:-1.5});
});
test('existing $4 stop migrates to $8 without resetting profit peak or increasing quantity',async()=>{
 const f=fixture();f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);f.e.newRules=true;const r=f.e.active()[0],qty=r.quantity;
 await f.e.cancelExits(r);r.rulesVersion=2;r.lossLimit=4;r.exits=[];await f.e.ensureExit(r,f.position,'sl4',-4);
 r.peak=5;r.profitFloor=4;const fees=r.fee*r.filledQty*(r.entry+Number(f.position.markPrice));f.position.unRealizedProfit=String(4.5+fees);
 await f.e.reconcile();assert.equal(r.lossLimit,8);assert.equal(r.quantity,qty);assert.equal(r.peak,5);assert.equal(r.profitFloor,4);assert.ok(r.exits.some(e=>e.kind==='sl4'&&e.cancelled));assert.ok(r.exits.some(e=>e.kind==='sl8'&&e.confirmed&&!e.cancelled));
});
test('50x accepts a smaller risk-sized trade below $100 available margin',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>{const result=await original(m,p,q,s);if(p==='/fapi/v3/account')result.assets[0].availableBalance='90';return result;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,1);assert.ok(Number(f.e.active()[0].quantity)*100/50<90);assert.equal(f.e.auto,true);
});
test('50x reduces quantity to keep estimated round-trip fees under $2',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.001'}:original(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,1);assert.equal(f.e.auto,true);assert.ok(Number(f.e.active()[0].quantity)*100*.001*2<=2);
});
test('five-minute fallback has enough complete candles and ignores partial groups',()=>{
 const {aggregateMinutes}=require('./engine.js'),t=Math.floor(Date.now()/300000)*300000-9000000;
 const raw=Array.from({length:150},(_,i)=>[t+i*60000,100,102,99,101,10,t+(i+1)*60000-1]);
 const bars=aggregateMinutes(raw,t+150*60000,5);assert.equal(bars.length,30);assert.equal(bars[0][5],50);assert.equal(bars[0][6]-bars[0][0],299999);
 assert.equal(aggregateMinutes(raw.slice(0,149),t+150*60000,5).length,29);
});
function recoveryBars(ms,side='BUY',at=Date.now()){
 const end=Math.floor(at/ms)*ms,start=end-30*ms;
 return Array.from({length:30},(_,i)=>{const c=side==='BUY'?100+i:140-i;return [start+i*ms,side==='BUY'?c-.6:c+.6,c+.8,c-.8,c,i===29?20:10,start+(i+1)*ms-1];});
}
test('recovery signal requires directional closed candles and trend for BUY and SELL',()=>{
 const {recoverySignal}=require('./engine.js'),at=Date.now();
 for(const side of ['BUY','SELL']){
  const raw=recoveryBars(60000,side,at),trend=recoveryBars(300000,side,at);
  // Increase candle body to meet the explicit 40% rule.
  raw.at(-1)[1]=Number(raw.at(-1)[4])+(side==='BUY'?-.7:.7);raw.at(-1)[2]=Number(raw.at(-1)[4])+(side==='BUY'?.1:.9);raw.at(-1)[3]=Number(raw.at(-1)[4])-(side==='BUY'?.9:.1);
  assert.equal(recoverySignal(raw,trend,side,at),true);
  assert.equal(recoverySignal(raw,trend,side,at+400000),false);
  raw.at(-1)[5]=1;assert.equal(recoverySignal(raw,trend,side,at),false);
 }
});
async function recoveryFixture(){
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0],original=f.api.call;
 f.setNet=n=>{f.position.unRealizedProfit=String(n+r.fee*r.filledQty*(r.entry+Number(f.position.markPrice)));};
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines'){const bars=recoveryBars(q.interval==='1m'?60000:300000);bars.at(-1)[1]=Number(bars.at(-1)[4])-.7;bars.at(-1)[2]=Number(bars.at(-1)[4])+.1;bars.at(-1)[3]=Number(bars.at(-1)[4])-.9;return bars;}return original(m,p,q,s);};
 f.setNet(-7);r.recoveryObservation={net:-7.5,at:Date.now()-5000};return {...f,r};
}
test('qualified recovery confirms $12 before cancelling $8 and closes at $12',async()=>{
 const f=await recoveryFixture(),r=f.r,start=f.calls.length;
 await f.e.reconcile();assert.equal(r.lossLimit,12);assert.equal(r.recoveryExtended,true);
 const calls=f.calls.slice(start),add=calls.findIndex(c=>c.method==='POST'&&c.path==='/fapi/v1/algoOrder'&&c.p.clientAlgoId.endsWith('_sl12')),remove=calls.findIndex(c=>c.method==='DELETE'&&c.p.clientAlgoId.endsWith('_sl8'));
 assert.ok(add>=0&&remove>add);assert.equal(f.e.active().length,1);
 f.setNet(-9);await f.e.reconcile();assert.equal(f.e.active().length,1);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/algoOrder'&&c.p.clientAlgoId.endsWith('_sl12')).length,1);
 f.setNet(-12.01);await f.e.reconcile();assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'$12 loss threshold');
});
test('unavailable recovery data leaves $8 stop and does not pause auto',async()=>{
 const f=await recoveryFixture(),original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines')throw Error('Offline');return original(m,p,q,s);};
 await f.e.reconcile();assert.equal(f.r.lossLimit,8);assert.equal(f.e.auto,true);assert.ok(!f.r.recoveryExtended);
 f.setNet(-8.01);await f.e.reconcile();assert.equal(f.e.active().length,0);
});
test('worsening loss cannot extend and failed recovery protection does not continue trading',async()=>{
 const f=await recoveryFixture();f.r.recoveryObservation.net=-6.5;
 await f.e.reconcile();assert.equal(f.r.lossLimit,8);
 f.r.recoveryObservation={net:-7.5,at:Date.now()-1000};const original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/algoOrder'&&q.clientAlgoId.endsWith('_sl12'))throw new DemoError('Rejected',-1111);return original(m,p,q,s);};
 await assert.rejects(()=>f.e.reconcile());assert.equal(f.e.auto,false);assert.equal(f.e.active().length,0);
});
test('loss crossing $8 during recovery check closes rather than extending',async()=>{
 const f=await recoveryFixture(),original=f.api.call;let crossed=false;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v3/positionRisk'&&!crossed){f.setNet(-9);crossed=true;}return original(m,p,q,s);};
 await f.e.reconcile();assert.equal(f.r.lossLimit,8);assert.ok(!f.r.recoveryExtended);assert.equal(f.e.active().length,0);
});
test('recovery extension survives reload without adding position or leverage',async()=>{
 const f=await recoveryFixture(),r=f.r,qty=r.quantity;
 await f.e.reconcile();const before=f.calls.length;
 const e=new DemoEngine(f.api,JSON.parse(JSON.stringify(f.e.state)),()=>{});await e.refresh();await e.reconcile();
 assert.equal(e.active()[0].lossLimit,12);assert.equal(e.active()[0].quantity,qty);
 assert.ok(!f.calls.slice(before).some(c=>c.method==='POST'));
});
test('Binance unrealized +10 remains +10 while booked costs and losses make net -30',()=>{
 const f=fixture();f.e.newRules=true;f.e.positions=[{symbol:'BTCUSDT',unRealizedProfit:'15'},{symbol:'ETHUSDT',unRealizedProfit:'-5'},{symbol:'BTCUSDC',unRealizedProfit:'99'}];
 f.e.income=[{incomeType:'REALIZED_PNL',income:'-35'},{incomeType:'COMMISSION',income:'-4'},{incomeType:'FUNDING_FEE',income:'-1'}];
 assert.equal(f.e.unrealizedPnl(),10);assert.equal(f.e.sessionNet(),-30);assert.equal(f.e.incomeBreakdown().net,-40);
 f.e.state.dayOpenPnl=3;assert.equal(f.e.unrealizedPnl(),10);assert.equal(f.e.sessionNet(),-33);
});
test('reset baseline starts from reset time and does not change signed unrealized PnL',async()=>{
 const f=fixture();f.e.newRules=true;await f.e.resetFromBinance();const reset=f.e.state.resetAt;f.e.syncDaily();
 assert.equal(f.e.state.startedAt,reset);assert.equal(f.e.unrealizedPnl(),0);assert.equal(f.e.sessionNet(),0);
 f.e.positions=[{symbol,unRealizedProfit:'-10.25'}];assert.equal(f.e.unrealizedPnl(),-10.25);
});
test('$100 net goal includes booked fees and funding, then closes and latches across midnight',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.e.income=[{income:'-5'},{income:'-1'}];f.e.lastIncome=Date.now();f.position.unRealizedProfit='105.99';await f.e.refresh();
 assert.equal(await f.e.enforceSessionGoal(),false);assert.equal(f.e.active().length,1);
 f.position.unRealizedProfit='106';await f.e.refresh();assert.equal(await f.e.enforceSessionGoal(),true);
 assert.equal(f.e.auto,false);assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'$100 net session target');assert.equal(f.e.state.goalNet,100);
 const stamp=f.e.state.goalStopAt;f.api.offset+=86400000;f.e.syncDaily();assert.equal(f.e.state.goalStopAt,stamp);
 f.e.income=[];assert.equal(await f.e.enforceSessionGoal(),true);assert.equal(f.e.auto,false);
});
test('goal shutdown attempts every bot position even when one close fails',async()=>{
 const e=new DemoEngine({offset:0},{version:1,records:[{id:'bd1_a',symbol:'AAAUSDT',side:'BUY'},{id:'bd1_b',symbol:'BBBUSDT',side:'SELL'}],startedAt:Date.now()-1000},()=>{});
 e.auto=true;e.lastIncome=Date.now();e.income=[{income:'100'}];e.positions=[{symbol:'AAAUSDT',positionAmt:'1',unRealizedProfit:'0'},{symbol:'BBBUSDT',positionAmt:'-1',unRealizedProfit:'0'},{symbol:'MANUALUSDT',positionAmt:'1',unRealizedProfit:'0'}];
 const attempts=[];e.close=async s=>{attempts.push(s);if(s==='AAAUSDT')throw new DemoError('Uncertain close',0,true);};
 await assert.rejects(()=>e.enforceSessionGoal(),/AAAUSDT/);assert.deepEqual(attempts,['AAAUSDT','BBBUSDT']);assert.equal(e.auto,false);assert.ok(e.state.goalStopAt);
});
test('explicit new session clears target lock and starts a fresh PnL window when flat',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.goalStopAt=Date.now()-1000;f.e.state.goal=true;f.e.state.dayOpenPnl=50;f.e.income=[{income:'100'}];let restarted=false;
 f.e.start=async()=>{restarted=true;};await f.e.again();assert.equal(restarted,true);assert.equal(f.e.state.goalStopAt,undefined);assert.equal(f.e.state.goal,false);assert.equal(f.e.sessionNet(),0);assert.equal(f.e.state.resetAt,f.e.state.startedAt);
});
test('selective mode rejects weak agreement before any exchange calls',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.strength=1;await f.e.enter(symbol,f.signal);
 assert.equal(f.calls.length,0);assert.match(f.e.entryOutcome,/stronger/);
});
test('selective mode waits ten minutes after a closed trade and caps concurrency',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.records=[{id:'bd1_old',symbol,side:'BUY',at:Date.now()-600000,closedAt:Date.now()-300000,entryStatus:'FILLED'}];
 await f.e.enter(symbol,f.signal);assert.match(f.e.entryOutcome,/cooldown/);assert.equal(f.calls.length,0);
 f.e.state.records=Array.from({length:3},(_,i)=>({id:'bd1_'+i,symbol:'COIN'+i+'USDT',side:'BUY',at:Date.now()-600000,entryStatus:'FILLED'}));
 await f.e.enter(symbol,f.signal);assert.match(f.e.entryOutcome,/three bot positions/);
});
test('selective mode spaces new fills and sizes round-trip commission to at most $1',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';
 f.e.state.records=[{id:'bd1_recent',symbol:'OTHERUSDT',side:'BUY',at:Date.now()-10000,entryStatus:'FILLED'}];
 await f.e.enter(symbol,f.signal);assert.match(f.e.entryOutcome,/60 seconds/);f.e.state.records=[];
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];assert.ok(Number(r.quantity)*100*r.fee*2<=1);assert.equal(r.lossLimit,8);
});
test('longer timeframes aggregate complete aligned 5m groups through 60m',()=>{
 const {aggregateFiveMinuteBars}=require('./engine.js'),t=Math.floor(Date.now()/3600000)*3600000-25*3600000;
 const raw=Array.from({length:300},(_,i)=>[t+i*300000,100,102,99,101,10,t+(i+1)*300000-1]);
 for(const minutes of [10,15,20,30,60]){const bars=aggregateFiveMinuteBars(raw,t+300*300000,minutes);assert.equal(bars.length,1500/minutes);assert.equal(bars[0][6]-bars[0][0],minutes*60000-1);assert.equal(bars[0][5],minutes*2);}
 assert.equal(aggregateFiveMinuteBars(raw.slice(0,299),t+300*300000,60).length,24);
});
test('trend cache reuses closed data within a 5m period and refreshes at next boundary',async()=>{
 const f=fixture();let calls=0;f.api.call=async()=>{calls++;return [];};
 await f.e.scanTrendBars(symbol);await f.e.scanTrendBars(symbol);assert.equal(calls,1);
 f.api.offset+=300000;await f.e.scanTrendBars(symbol);assert.equal(calls,2);
});
test('scanner checks longer timeframes when minute chart has no breakout',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol];const at=Date.now(),end=Math.floor(at/300000)*300000;
 const minuteEnd=Math.floor(at/60000)*60000;
 const raw=Array.from({length:150},(_,i)=>[minuteEnd-(150-i)*60000,100,101,99,100,10,minuteEnd-(149-i)*60000-1]);
 const trend=Array.from({length:300},(_,i)=>{const c=100+i*.01;return [end-(300-i)*300000,c-.035,c+.001,c-.04,c,i>=298?30:10,end-(299-i)*300000-1];});
 f.api.call=async(m,p,q)=>{assert.equal(p,'/fapi/v1/klines');return q.interval==='1m'?raw:trend;};
 f.e.updateIncome=async()=>{};let captured;f.e.enter=async(s,signal)=>{captured=signal;f.e.entryOutcome='Test entry';};
 await f.e.scan();assert.ok(captured);assert.ok(captured.intervalMs>=600000);assert.equal(captured.side,'BUY');
});
test('movers rank eligible futures only and alternate gainers BUY / losers SELL',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=['AAAUSDT','BBBUSDT','CCCUSDT'];for(const s of f.e.symbols)f.e.meta.set(s,{});
 const row=(symbol,change,closeTime=Date.now())=>({symbol,priceChangePercent:String(change),lastPrice:'1',quoteVolume:'100000',closeTime});let calls=0;
 f.api.call=async()=>{calls++;return [row('AAAUSDT',12),row('BBBUSDT',-20),row('CCCUSDT',3),row('SPOTONLYUSDT',100),row('AAAUSDT',99,Date.now()-700000)];};
 await f.e.refreshMovers();assert.deepEqual(f.e.movers.map(x=>[x.symbol,x.side]),[['AAAUSDT','BUY'],['BBBUSDT','SELL'],['CCCUSDT','BUY']]);
 await f.e.refreshMovers();assert.equal(calls,1);
});
test('mover scan starts with ranked markets and still advances full market cursor',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=Array.from({length:20},(_,i)=>'C'+i+'USDT');for(const s of f.e.symbols)f.e.meta.set(s,{});
 const seen=[];f.api.call=async(m,p,q)=>{if(p==='/fapi/v1/ticker/24hr')return [{symbol:'C19USDT',priceChangePercent:'20',lastPrice:'1',quoteVolume:'1000',closeTime:Date.now()},{symbol:'C18USDT',priceChangePercent:'-20',lastPrice:'1',quoteVolume:'1000',closeTime:Date.now()}];seen.push(q.symbol);return [];};
 await f.e.scan();assert.deepEqual(seen.slice(0,2),['C19USDT','C18USDT']);assert.equal(f.e.cursor,8);assert.ok(seen.includes('C0USDT'));assert.ok(seen.includes('C7USDT'));
 assert.ok(f.e.scanned.some(s=>s.symbol==='C19USDT'&&s.source==='Gainer 20.00%'));
});
test('movers outage falls back to all-market scanning without auto stop',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol];let candles=0;
 f.api.call=async(m,p)=>{if(p==='/fapi/v1/ticker/24hr')throw new DemoError('Unavailable',503);candles++;return [];};
 await f.e.scan();assert.equal(candles,1);assert.equal(f.e.auto,true);assert.match(f.e.moversNote,/unavailable/);
});
test('loser priority does not execute a BUY signal',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol];f.e.movers=[{symbol,side:'SELL',change:-10}];f.e.moversCheckedAt=Date.now();
 const at=Date.now(),end=Math.floor(at/300000)*300000,minuteEnd=Math.floor(at/60000)*60000;
 const raw=Array.from({length:150},(_,i)=>[minuteEnd-(150-i)*60000,100,101,99,100,10,minuteEnd-(149-i)*60000-1]);
 const trend=Array.from({length:300},(_,i)=>{const c=100+i*.01;return [end-(300-i)*300000,c-.035,c+.001,c-.04,c,i>=298?30:10,end-(299-i)*300000-1];});
 f.api.call=async(m,p,q)=>q.interval==='1m'?raw:trend;let entries=0;f.e.enter=async()=>entries++;
 await f.e.scan();assert.equal(entries,0);assert.match(f.e.scanned[0].reason,/SELL confirmation/);
});
