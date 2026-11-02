const {test}=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {DemoAPI,DemoEngine,DemoError,rounded,breakout,qualifySetup,exitPrice,combinedValue}=require('./engine.js');
const {fixture,entryBars,continuationBars,lowVolatility,closingQuote,reductionPosts,setTradeNet,now,symbol}=require('./test-fixture.cjs');
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
 const f=fixture();await f.e.enter(symbol,f.signal);f.position.markPrice='108';f.position.unRealizedProfit='22.5';await f.e.refresh();await f.e.reconcile();assert(f.e.owned(symbol).exits.some(e=>e.kind==='floor'&&f.algos.has(e.id)));assert.equal(f.algos.size,3);
 await f.e.close(symbol);assert.equal(f.position,null);assert.equal(f.e.active().length,0);assert([...f.algos.values()].every(a=>a.algoStatus==='CANCELED'));
});
test('Stop Auto during configuration prevents entry dispatch',async()=>{
 const f=fixture(),base=f.api.call;f.api.call=async(...args)=>{const r=await base(...args);if(args[1]==='/fapi/v1/leverage')f.e.pause();return r;};await f.e.enter(symbol,f.signal);assert(!f.calls.some(c=>c.path==='/fapi/v1/order'&&c.method==='POST'));
});
test('reload reconciles saved order and exits, does not submit another entry',async()=>{
 const f=fixture();await f.e.enter(symbol,f.signal);const restored=new DemoEngine(f.api,JSON.parse(JSON.stringify(f.e.state)),()=>{});await restored.refresh();await restored.reconcile();assert(restored.active()[0].exitsReady);assert.equal(restored.auto,false);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
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
  const e=new DemoEngine(api);e.newRules=false;e.bandRules=false;e.experimentUntil=0;e.auto=true;e.symbols=Array.from({length:25},(_,i)=>'COIN'+i);
  await e.scan();assert.equal(calls.length,12);assert.equal(e.scanChecked,12);
  await e.scan();assert.equal(calls.length,24);assert.equal(new Set(calls).size,24);
  assert.ok(e.scanned.every(s=>s.side==='WAIT'&&s.reason==='Not enough closed candle history'));
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
 e.newRules=false;e.bandRules=false;e.experimentUntil=0;e.auto=true;e.symbols=['AUSDT','BUSDT','CUSDT'];await e.scan();await e.scan();
 assert.deepEqual(calls,['AUSDT','BUSDT','CUSDT','AUSDT','BUSDT','CUSDT']);
 assert.equal(e.scanned.length,3);assert.equal(e.scanChecked,6);
});
test('recent candidate is rechecked before cursor reaches it without starving the full scan',async()=>{
 const calls=[],e=new DemoEngine({offset:0,call:async(m,p,q)=>{calls.push(q.symbol);return [];}});
 e.newRules=false;e.bandRules=false;e.experimentUntil=0;e.auto=true;e.symbols=Array.from({length:40},(_,i)=>'C'+i+'USDT');e.cursor=15;
 e.rechecks=new Map([['C0USDT',{seen:Date.now(),checked:Date.now()-31000}]]);
 await e.scan();assert.equal(calls[0],'C0USDT');assert.equal(calls.length,13);assert.equal(e.cursor,27);
});
test('a qualifying signal reports why execution was skipped',async()=>{
 const f=fixture();f.signal.price=90;await f.e.enter(symbol,f.signal);
 assert.equal(f.e.entryOutcome,'Price moved too far from the confirmed candle');
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
test('$300 margin adapts leverage to observed volatility while retaining a $5 loss stop',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.leverage,5);assert.equal(r.lossLimit,5);assert.equal(r.exitsReady,true);
 assert.equal(Number(r.quantity)*100/r.leverage,300);assert.equal(r.estimatedEntryMargin,300);
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

test('10x adaptive choice falls back to 6x without shrinking margin below $300',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';lowVolatility(f);const original=f.api.call,attempts=[];f.signal.stopDistance=.1;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverage'){attempts.push(q.leverage);if(q.leverage>6)throw new DemoError('Unsupported leverage',-4028);}return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(attempts[0],10);assert.equal(attempts.at(-1),6);assert.ok(attempts.length<=8);const r=f.e.active()[0];assert.equal(r.leverage,6);assert.equal(r.lossLimit,5);assert.equal(r.exitsReady,true);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly).length,1);
 assert.equal(Number(r.quantity)*100/6,300);
});
test('profit floors advance in five-dollar steps after 32',()=>{
 const {profitFloor}=require('./engine.js');
 for(const [peak,floor] of [[32,16],[32.01,32],[37,32],[37.01,37],[42,37],[42.01,42],[48,47],[100,97]])assert.equal(profitFloor(peak),floor);
});
test('income breakdown separates winning PnL, losses, commission and funding',()=>{
 const f=fixture();f.e.income=[{incomeType:'REALIZED_PNL',income:'12'},{incomeType:'REALIZED_PNL',income:'-8'},{incomeType:'COMMISSION',income:'-5'},{incomeType:'FUNDING_FEE',income:'-.5'}];
 assert.deepEqual(f.e.incomeBreakdown(),{gains:12,losses:-8,realized:4,commission:-5,funding:-.5,net:-1.5});
});

test('below $300 available margin never submits a smaller trade and keeps scanning',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>{const result=await original(m,p,q,s);if(p==='/fapi/v3/account')result.assets[0].availableBalance='190';return result;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/at least \$300/);assert.equal(f.e.auto,true);assert.ok(!f.calls.some(c=>c.method==='POST'));
});
test('entry is skipped when fees already consume the $5 loss allowance',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.strength=3;const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.002'}:base(m,p,q,s);await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/loss|stop|fees/i);
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
test('$100 net goal includes booked fees and funding, then pauses entries and latches across midnight and closes bot positions',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.e.income=[{income:'-5'},{income:'-1'}];f.e.lastIncome=Date.now();setTradeNet(f,105.99);await f.e.refresh();
 assert.equal(await f.e.enforceSessionGoal(),false);assert.equal(f.e.active().length,1);
 setTradeNet(f,106);await f.e.refresh();assert.equal(await f.e.enforceSessionGoal(),true);
 assert.equal(f.e.auto,false);assert.equal(f.e.active().length,0);assert.equal(r.closeReason,'$100 net session target');assert.equal(f.e.state.goalNet,100);
 const stamp=f.e.state.goalStopAt;f.api.offset+=86400000;f.e.syncDaily();assert.equal(f.e.state.goalStopAt,stamp);
 f.e.income=[];assert.equal(await f.e.enforceSessionGoal(),true);assert.equal(f.e.auto,false);
});
test('session goal closes winning and losing bot positions but not unmanaged positions',async()=>{
 const e=new DemoEngine({offset:0},{version:1,records:[{id:'bd1_a',symbol:'AAAUSDT',side:'BUY',entryStatus:'FILLED'},{id:'bd1_b',symbol:'BBBUSDT',side:'SELL',entryStatus:'FILLED'}],startedAt:Date.now()-1000},()=>{});
 e.estimateSessionClose=async()=>100; e.auto=true;e.lastIncome=Date.now();e.income=[{income:'105'}];e.positions=[{symbol:'AAAUSDT',positionAmt:'1',unRealizedProfit:'10'},{symbol:'BBBUSDT',positionAmt:'-1',unRealizedProfit:'-15'},{symbol:'MANUALUSDT',positionAmt:'1',unRealizedProfit:'0'}];
 const closed=[];e.close=async(symbol,reason)=>{closed.push([symbol,reason]);e.owned(symbol).closedAt=Date.now();e.positions=e.positions.filter(p=>p.symbol!==symbol);};
 assert.equal(await e.enforceSessionGoal(),true);assert.equal(e.auto,false);assert.ok(e.state.goalStopAt);assert.equal(e.active().length,0);
 assert.deepEqual(closed,[['AAAUSDT','$100 net session target'],['BBBUSDT','$100 net session target']]);assert.deepEqual(e.positions.map(p=>p.symbol),['MANUALUSDT']);
});
test('explicit new session clears target lock and starts a fresh PnL window when flat',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.goalStopAt=Date.now()-1000;f.e.state.goal=true;f.e.state.dayOpenPnl=50;f.e.income=[{income:'100'}];let restarted=false;
 f.e.start=async()=>{restarted=true;};await f.e.again();assert.equal(restarted,true);assert.equal(f.e.state.goalStopAt,undefined);assert.equal(f.e.state.goal,false);assert.equal(f.e.sessionNet(),0);assert.equal(f.e.state.resetAt,f.e.state.startedAt);
});
test('missing candle agreement is rejected before any exchange calls',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.strength=0;await f.e.enter(symbol,f.signal);
 assert.equal(f.calls.length,0);assert.match(f.e.entryOutcome,/agreement is missing/);
});
test('re-entry cooldown remains but three active positions do not block another entry',async()=>{
 const f=fixture();f.e.newRules=true;f.e.state.records=[{id:'bd1_old',symbol,side:'BUY',at:Date.now()-600000,closedAt:Date.now()-300000,entryStatus:'FILLED'}];
 await f.e.enter(symbol,f.signal);assert.match(f.e.entryOutcome,/cooldown/);assert.equal(f.calls.length,0);
 f.e.reconcile=async()=>{};f.e.state.records=Array.from({length:3},(_,i)=>({id:'bd1_'+i,symbol:'COIN'+i+'USDT',side:'BUY',at:Date.now()-600000,entryStatus:'FILLED'}));
 await f.e.enter(symbol,f.signal);assert.ok(f.calls.some(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly));
});
test('another symbol can enter immediately after a filled trade within margin capacity',async()=>{
 const f=fixture();f.e.newRules=true;f.e.reconcile=async()=>{};
 f.e.state.records=[{id:'bd1_recent',symbol:'OTHERUSDT',side:'BUY',at:Date.now()-10000,entryStatus:'FILLED'}];
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);
 assert.ok(r?.exitsReady);assert.equal(r.lossLimit,5);assert.equal(r.leverage,5);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('longer timeframes aggregate complete aligned 5m groups through 60m',()=>{
 const {aggregateFiveMinuteBars}=require('./engine.js'),t=Math.floor(Date.now()/3600000)*3600000-25*3600000;
 const raw=Array.from({length:300},(_,i)=>[t+i*300000,100,102,99,101,10,t+(i+1)*300000-1]);
 for(const minutes of [10,15,20,30,60]){const bars=aggregateFiveMinuteBars(raw,t+300*300000,minutes);assert.equal(bars.length,1500/minutes);assert.equal(bars[0][6]-bars[0][0],minutes*60000-1);assert.equal(bars[0][5],minutes*2);}
 assert.equal(aggregateFiveMinuteBars(raw.slice(0,299),t+300*300000,60).length,24);
});
test('trend cache reuses closed data within a 5m period and refreshes at next boundary',async()=>{
 const f=fixture();let calls=0;f.api.call=async()=>{calls++;const end=Math.floor((Date.now()+f.api.offset)/300000)*300000;return Array.from({length:30},(_,i)=>[end-(30-i)*300000,100,101,99,100,10,end-(29-i)*300000-1]);};
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
 await f.e.scan();assert.deepEqual(seen.slice(0,2),['C19USDT','C18USDT']);assert.equal(f.e.cursor,4);assert.ok(seen.includes('C0USDT'));assert.ok(seen.includes('C3USDT'));
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
 await f.e.scan();assert.equal(entries,0);assert.equal(f.e.scanned[0].side,'WAIT');assert.match(f.e.scanned[0].source,/Loser/);
});

test('lower fees allow higher adaptive leverage at the same $300 margin',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.strength=3;f.signal.stopDistance=.1;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.00005'}:p==='/fapi/v1/klines'?entryBars(f.signal.side,Date.now(),2):original(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.leverage,8);assert.equal(r.estimatedEntryMargin,300);assert.equal(r.lossLimit,5);assert.equal(r.exitsReady,true);
});
test('lot rounding never rounds new BUY or SELL margin below $300',async()=>{
 for(const side of ['BUY','SELL']){
  const f=fixture();f.e.newRules=true;f.signal.side=side;f.e.marketContext.side=side;if(side==='SELL')f.signal.low=101;
  for(const filter of f.e.meta.get(symbol).filters)if(['MARKET_LOT_SIZE','LOT_SIZE'].includes(filter.filterType))filter.stepSize='.03';
  await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
  assert.equal(r.leverage,5);assert.equal(r.quantity,'15.00');assert.ok(r.estimatedEntryMargin>=300&&r.estimatedEntryMargin<301);
  assert.equal(r.exitsReady,true);assert.equal(r.lossLimit,5);
 }
});
test('$300 margin also needs fee room; no undersized order when the remaining margin budget is too small',async()=>{
 for(const cause of ['fees','budget']){
  const f=fixture();f.e.newRules=true;const original=f.api.call;
  if(cause==='budget')f.e.budgetStatus=()=>({reserved:4701});
  else f.api.call=async(m,p,q,s)=>{const result=await original(m,p,q,s);if(p==='/fapi/v3/account')result.assets[0].availableBalance='300';return result;};
  await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);
  assert.ok(!f.calls.some(c=>c.method==='POST'&&c.path==='/fapi/v1/order'));
 }
});
test('Binance notional cap can lower leverage but never cut margin below $300',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverage'?{leverage:q.leverage,maxNotionalValue:'350'}:original(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.leverage,1);assert.equal(r.estimatedEntryMargin,300);assert.equal(r.exitsReady,true);
});
test('higher recent 1m volatility lowers leverage while keeping $300 margin',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.stopDistance=20;const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars(f.signal.side,Date.now(),5):base(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.leverage,3);assert.equal(r.estimatedEntryMargin,300);assert.equal(r.lossLimit,5);assert.equal(r.exitsReady,true);
});

for(const maximum of [1,2,10,17,20,25,35,49,50])test('exchange maximum '+maximum+'x caps an adaptive 10x choice with $300 margin',async()=>{
 const f=fixture();f.e.newRules=true;lowVolatility(f);const original=f.api.call,attempts=[];
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverage'){attempts.push(q.leverage);if(q.leverage>maximum)throw new DemoError('Maximum exceeded',-4209);}return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];assert.equal(r.leverage,Math.min(10,maximum));assert.equal(r.estimatedEntryMargin,300);assert.equal(r.lossLimit,5);
 assert.equal(attempts[0],10);assert.equal(attempts.at(-1),Math.min(10,maximum));assert.ok(attempts.length<=8);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly).length,1);
});
test('Stop during maximum-leverage fallback prevents entries',async()=>{
 const f=fixture();f.e.newRules=true;lowVolatility(f);const original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverage'&&q.leverage===10)throw new DemoError('Maximum exceeded',-4209);const out=await original(m,p,q,s);if(p==='/fapi/v1/leverage')f.e.pause();return out;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.auto,false);assert.equal(f.e.active().length,0);
});
test('uncertain leverage response never triggers fallback or an entry',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;let attempts=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverage'){attempts++;throw new DemoError('Timeout',0,true);}return original(m,p,q,s);};
 await assert.rejects(()=>f.e.enter(symbol,f.signal),/Timeout/);assert.equal(attempts,1);assert.equal(f.e.active().length,0);
});
test('coarse price ticks reject an unworkable $5 stop',async()=>{
 const f=fixture();f.e.newRules=true;f.e.meta.get(symbol).filters.find(x=>x.filterType==='PRICE_FILTER').tickSize='5';await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/stop|tick/i);
});

test('entry-time 1m momentum supports both sides and rejects reversal, stale and malformed candles',()=>{
 const {entryMomentum}=require('./engine.js');
 for(const side of ['BUY','SELL']){
  const at=Date.now(),bars=entryBars(side,at),result=entryMomentum(bars,side,at);
  assert.ok(result.atr>0);assert.equal(result.reason,undefined);
  assert.match(entryMomentum(bars,side==='BUY'?'SELL':'BUY',at).reason,/no longer confirms/);
  assert.match(entryMomentum(bars,side,at+180000).reason,/stale/);
  const bad=structuredClone(bars);bad[12][0]+=1;assert.throws(()=>entryMomentum(bad,side,at));
 }
});
test('a previously qualified long does not enter after fresh 1m momentum turns down',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars('SELL'):original(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);
 assert.match(f.e.entryOutcome,/reversal opposes.*BUY/);
 assert.ok(!f.calls.some(c=>c.method==='POST'));
});
test('public entry-candle read outage skips the entry without stopping the scanner',async()=>{
 const f=fixture();f.e.newRules=true;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/klines')throw new DemoError('Offline',503);return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/check unavailable/);
});
test('trade report separates gross result and costs without exposing credentials',()=>{
 const f=fixture();f.api.key='NEVER_EXPORT_API_KEY';f.api.relayToken='NEVER_EXPORT_LOCAL_TOKEN';
 f.e.income=[{incomeType:'REALIZED_PNL',income:'10',symbol,asset:'USDT',time:Date.now()},{incomeType:'COMMISSION',income:'-15',symbol,asset:'USDT',time:Date.now()}];
 f.e.lastIncome=Date.now();f.e.incomeWindowStart=f.e.state.startedAt;f.e.positionAt=Date.now();
 const report=f.e.tradeReport(),serialized=JSON.stringify(report);
 assert.equal(report.totals.realized,10);assert.equal(report.totals.commission,-15);assert.equal(report.totals.net,-5);
 assert.equal(report.strategyValidatedForProfit,false);assert.ok(!serialized.includes('NEVER_EXPORT'));
});

test('missing income is unavailable, never zero costs or a net session claim',()=>{
 const f=fixture();f.e.positionAt=Date.now();f.e.positions=[{symbol,unRealizedProfit:'-4.0344'}];
 const r=f.e.tradeReport();assert.equal(r.snapshotStatus.complete,false);assert.equal(r.snapshotStatus.income,'missing');
 assert.equal(r.totals,null);assert.equal(r.netSession,null);assert.equal(r.unrealized,-4.0344);
});
test('report distinguishes loaded zero income, stale data and a different session window',async()=>{
 const f=fixture();await f.e.refresh();await f.e.updateIncome();let r=f.e.tradeReport();
 assert.equal(r.snapshotStatus.complete,true);assert.equal(r.totals.net,0);assert.equal(r.netSession,0);
 f.e.lastIncome-=31000;r=f.e.tradeReport();assert.equal(r.snapshotStatus.income,'stale');assert.equal(r.netSession,null);
 f.e.state.startedAt++;r=f.e.tradeReport();assert.equal(r.snapshotStatus.income,'missing');assert.equal(r.totals,null);
});
test('bad income refresh preserves the previous validated snapshot atomically',async()=>{
 const f=fixture();await f.e.updateIncome();const at=f.e.lastIncome,rows=f.e.income;
 const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/income'?[{asset:'USDT',incomeType:'COMMISSION',income:'bad'}]:base(m,p,q,s);
 await assert.rejects(()=>f.e.updateIncome());assert.equal(f.e.income,rows);assert.equal(f.e.lastIncome,at);
});
test('report identifies unknown historical versions and preserves protection failure evidence',async()=>{
 const f=fixture();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));
 const r=f.e.tradeReport().botRecords[0];assert.equal(r.entryAppVersion,'1.63');assert.equal(r.protectionError.code,-1111);assert.match(r.protectionError.message,/unsupported/);
 delete f.e.state.records[0].entryAppVersion;delete f.e.state.records[0].closeReason;
 const old=f.e.tradeReport().botRecords[0];assert.equal(old.entryAppVersion,null);assert.match(old.closeReason,/cause unconfirmed/);
});
for(const side of ['BUY','SELL'])test(side+' quote guard blocks an already-triggered mark stop without stopping scanning',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.side=side;f.e.marketContext.side=side;if(side==='SELL')f.signal.low=101;
 const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:side==='BUY'?'101.99':'98.00',askPrice:side==='BUY'?'102.00':'98.01',bidQty:'1000',askQty:'1000',time:Date.now()}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);
 assert.match(f.e.entryOutcome,/entry sizing allowance|planned loss stop|loss target/);assert.ok(!f.calls.some(c=>c.path==='/fapi/v1/order'&&c.method==='POST'));
});
test('wide spread plus fees blocks entry even when the mark stop has room',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'98',askPrice:'100',bidQty:'1000',askQty:'1000',time:Date.now()}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/entry sizing allowance|planned loss stop|loss target/);
});
for(const problem of ['stale','invalid','unavailable'])test(problem+' bid/ask skips without an entry or stopping the scanner',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{
  if(p==='/fapi/v1/ticker/bookTicker'){
   if(problem==='unavailable')throw new DemoError('Quote endpoint unavailable',503);
   return {symbol,bidPrice:problem==='invalid'?'bad':'100',askPrice:'100',bidQty:'1000',askQty:'1000',time:Date.now()-(problem==='stale'?20000:0)};
  }return base(m,p,q,s);
 };
 await f.e.enter(symbol,f.signal);assert.equal(f.e.auto,true);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/quote check unavailable/);
});
test('Stop during final quote request prevents dispatch',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(p==='/fapi/v1/ticker/bookTicker')f.e.pause();return result;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/stopped before entry/);
});
test('accepted entry carries bid/ask, mark, fee and version evidence with $300 sizing',async()=>{
 const f=fixture();f.e.newRules=true;await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.equal(r.entryAppVersion,'1.63');assert.equal(r.estimatedEntryMargin,300);assert.equal(r.leverage,5);
 assert.ok(Math.abs(r.entryEvidence.estimatedMarkNet+1.5)<1e-8);assert.ok(Math.abs(r.entryEvidence.estimatedImmediateExitNet+1.5)<1e-8);
 assert.equal(r.entryEvidence.bid,100);assert.equal(r.entryEvidence.markPrice,100);assert.ok(Number.isFinite(r.entryEvidence.plannedStopPrice));
});

test('adaptive sizing respects fees, volatility, tick rounding and a 10x maximum on both sides',()=>{
 const {adaptiveLeveragePlan}=require('./engine.js');
 for(const side of ['BUY','SELL']){
  const choose=(atr,fee,tick='.01')=>adaptiveLeveragePlan({price:100,atr,fee,side,tick,lossLimit:8,plan:leverage=>({qty:3*leverage})});
  assert.equal(choose(.04,.00001).leverage,10);
  assert.ok(choose(.8,.0005).leverage<choose(.4,.0005).leverage);
  assert.ok(choose(.4,.001).leverage<choose(.4,.0001).leverage);
  assert.equal(choose(5,.0005),null);
  for(const [atr,fee,tick] of [[.4,.0005,'.01'],[.04,.00001,'.01'],[.4,.0005,'1']]){
   const choice=choose(atr,fee,tick);assert.ok(choice.leverage<=10);assert.ok(choice.stopDistance+1e-8>=atr);assert.ok(choice.estimatedLossAtOneAtr<=8+1e-8);
  }
 }
});
test('excessive volatility at $300 skips without changing margin or disabling Auto',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars(f.signal.side,Date.now(),20):base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/even at 1×/);
 assert.ok(!f.calls.some(c=>c.method==='POST'));
});
test('final quote still needs volatility room after leverage configuration',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'101.09',askPrice:'101.1',bidQty:'1000',askQty:'1000',time:Date.now()}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/entry sizing allowance|planned loss stop|loss target/);
});
test('eight movers are checked first, repeat across passes, and full-market scanning keeps advancing',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=Array.from({length:50},(_,i)=>'C'+i+'USDT');
 f.e.movers=Array.from({length:20},(_,i)=>({symbol:'C'+(30+i)+'USDT',side:i%2?'SELL':'BUY',change:i%2?-10:10}));f.e.moversCheckedAt=Date.now();
 const seen=[];f.api.call=async(m,p,q)=>{seen.push(q.symbol);return [];};
 await f.e.scan();assert.deepEqual(seen.slice(0,8),f.e.movers.slice(0,8).map(m=>m.symbol));assert.equal(f.e.cursor,4);
 await f.e.scan();await f.e.scan();
 for(const m of f.e.movers)assert.ok(seen.includes(m.symbol));
 assert.equal(seen.filter(s=>s==='C30USDT').length,2);assert.equal(f.e.cursor,12);assert.ok(seen.includes('C11USDT'));
});
function scanBars(side,ms,count){
 const end=Math.floor(Date.now()/ms)*ms,sign=side==='BUY'?1:-1;
 return Array.from({length:count},(_,i)=>{const close=100+i*.01*sign,open=close-.035*sign;return [end-(count-i)*ms,open,Math.max(open,close)+.001,Math.min(open,close)-.001,close,i>=count-2?30:10,end-(count-i-1)*ms-1];});
}
for(const [rankSide,signalSide,expected] of [['BUY','BUY',1],['SELL','SELL',1],['BUY','SELL',0],['SELL','BUY',0]])test('ranked '+rankSide+' preference applies to '+signalSide+' signals reached outside priority slots',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol,...Array.from({length:8},(_,i)=>'M'+i+'USDT')];
 f.e.movers=[...f.e.symbols.slice(1).map(s=>({symbol:s,side:'BUY',change:10})),{symbol,side:rankSide,change:rankSide==='BUY'?5:-5}];f.e.moversCheckedAt=Date.now();
 f.api.call=async(m,p,q)=>q.symbol===symbol?scanBars(signalSide,q.interval==='1m'?60000:300000,q.interval==='1m'?150:300):[];
 const signals=[];f.e.updateIncome=async()=>{};f.e.enforceSessionGoal=async()=>false;f.e.enter=async(s,signal)=>signals.push(signal);
 await f.e.scan();assert.equal(signals.length,expected);
 if(expected){assert.equal(signals[0].side,rankSide);assert.equal(signals[0].marketSource.type,rankSide==='BUY'?'gainer':'loser');}
});
test('an unranked coin still executes a qualifying signal after priority checks',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol];f.e.moversCheckedAt=Date.now();
 f.api.call=async(m,p,q)=>scanBars('BUY',q.interval==='1m'?60000:300000,q.interval==='1m'?150:300);
 let signal;f.e.updateIncome=async()=>{};f.e.enforceSessionGoal=async()=>false;f.e.enter=async(s,v)=>signal=v;
 await f.e.scan();assert.equal(signal.side,'BUY');assert.equal(signal.marketSource.type,'full-market');
});

test('scanner bounds concurrent public work at three and does not wait for a slow first coin',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT','CUSDT','DUSDT'];f.e.moversCheckedAt=Date.now();
 const releases=new Map();let active=0,maximum=0;const entered=[];
 f.e.scanCandidate=async(symbol)=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>releases.set(symbol,resolve));active--;return {symbol,signal:symbol==='BUSDT'?{side:'BUY'}:null,intervalMs:60000,reason:'Test rule',scanMs:1};};
 f.e.ensureIncomeFresh=async()=>{};f.e.enter=async symbol=>{entered.push(symbol);f.e.entryOutcome='Test submission';};
 const scanning=f.e.scan();await new Promise(setImmediate);assert.equal(active,3);assert.ok(!releases.has('DUSDT'));
 releases.get('BUSDT')();await new Promise(setImmediate);assert.deepEqual(entered,['BUSDT']);assert.ok(releases.has('DUSDT'));assert.equal(active,3);
 for(const release of releases.values())release();await scanning;assert.equal(maximum,3);assert.equal(f.e.scanStats.completed,4);
});
test('concurrent signals still enter one at a time',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT','CUSDT'];f.e.moversCheckedAt=Date.now();let active=0,maximum=0,count=0;
 f.e.scanCandidate=async symbol=>({symbol,signal:{side:'BUY'},intervalMs:60000,scanMs:0});f.e.ensureIncomeFresh=async()=>{};
 f.e.enter=async()=>{active++;maximum=Math.max(maximum,active);await new Promise(setImmediate);count++;active--;};
 await f.e.scan();assert.equal(count,3);assert.equal(maximum,1);
});
test('a public candle outage marks that row and does not stop other coins',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT'];f.e.moversCheckedAt=Date.now();
 f.e.scanCandidate=async symbol=>{if(symbol==='AUSDT')throw new DemoError('Timeout',0);return {symbol,reason:'No signal',scanMs:1};};
 await f.e.scan();assert.equal(f.e.auto,true);assert.equal(f.e.scanned.find(r=>r.symbol==='AUSDT').phase,'Data error');assert.equal(f.e.scanStats.completed,2);assert.equal(f.e.scanStats.dataErrors,1);
});
test('rate-limit responses abort the scan instead of opening from another candidate',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT'];f.e.moversCheckedAt=Date.now();let entered=0;
 f.e.scanCandidate=async symbol=>{if(symbol==='AUSDT')throw new DemoError('Rate limit',429);return {symbol,signal:{side:'BUY'},intervalMs:60000};};f.e.enter=async()=>entered++;
 await assert.rejects(()=>f.e.scan(),e=>e.code===429);assert.equal(entered,0);assert.equal(f.e.scanController,null);
});
test('Stop cancels in-flight scan reads and never submits their late signals',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT','CUSDT'];f.e.moversCheckedAt=Date.now();let aborted=0,entered=0;
 f.e.scanCandidate=async(symbol,mover,epoch,controller)=>{await new Promise(resolve=>controller.signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));return {symbol,signal:{side:'BUY'},intervalMs:60000};};f.e.enter=async()=>entered++;
 const scanning=f.e.scan();await new Promise(setImmediate);f.e.pause();await scanning;assert.equal(aborted,3);assert.equal(entered,0);assert.equal(f.e.auto,false);
});
test('queued manual control cancels the rest of a scan before any order',async()=>{
 const f=fixture();f.e.symbols=['AUSDT','BUSDT'];f.e.moversCheckedAt=Date.now();let entered=0;
 f.e.scanCandidate=async symbol=>{f.e.controlPending=true;return {symbol,signal:{side:'BUY'},intervalMs:60000};};f.e.enter=async()=>entered++;
 await f.e.scan();assert.equal(entered,0);assert.equal(f.e.scanController,null);
});
test('profit exit is serviced while public scanner requests are still pending',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.exitPolicy='manual-profit-60s-loss';await f.e.enter(symbol,f.signal);
 const r=f.e.active()[0];setTradeNet(f,11);await f.e.reconcile();setTradeNet(f,10);f.e.positionAt=0;f.e.tradingReady=true;
 f.e.symbols=['OTHERUSDT'];f.e.moversCheckedAt=Date.now();
 f.e.scanCandidate=async(symbol,mover,epoch,controller)=>{await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));return {symbol};};
 const scanning=f.e.scan();try{await new Promise(setImmediate);assert.equal(f.position,null);assert.match(r.closeReason,/Net profit trailing pullback/);}finally{f.e.pause();await scanning;}
});
test('minute cache reuses completed candles but fetches again after the next boundary',async()=>{
 const f=fixture();let calls=0;f.api.call=async()=>{calls++;return entryBars('BUY',Date.now()+f.api.offset);};
 await f.e.scanBars(symbol,'1m',150);await f.e.scanBars(symbol,'1m',150);assert.equal(calls,1);
 f.api.offset=60000;await f.e.scanBars(symbol,'1m',150);assert.equal(calls,2);
});
test('income snapshot is reused only inside its freshness limit and the same session',async()=>{
 const f=fixture();let calls=0;f.api.call=async()=>{calls++;return [];};
 await f.e.ensureIncomeFresh();await f.e.ensureIncomeFresh();assert.equal(calls,1);
 f.e.lastIncome-=6000;await f.e.ensureIncomeFresh();assert.equal(calls,2);
 f.e.state.startedAt++;await f.e.ensureIncomeFresh();assert.equal(calls,3);
});
test('entry avoids duplicate all-market inventory reads while retaining fresh symbol checks',async()=>{
 const f=fixture();f.e.newRules=true;await f.e.enter(symbol,f.signal);
 const before=f.calls.slice(0,f.calls.findIndex(c=>c.path==='/fapi/v1/order'&&c.method==='POST'));
 for(const path of ['/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'])assert.equal(before.filter(c=>c.path===path).length,1);
 assert.ok(before.filter(c=>c.path.includes('open')).every(c=>c.p.symbol===symbol));assert.ok(f.e.entryTiming.totalMs>=0);assert.ok(f.e.entryTiming.stages.length>3);
 assert.ok(f.e.active()[0].entryEvidence.timing);
});
test('API diagnostics exclude signed query data, headers and credentials',async()=>{
 const secret='never-export-this-secret',key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const api=new DemoAPI('never-export-this-key',key,async url=>({ok:true,json:async()=>url.includes('/time')?{serverTime:Date.now()}:{ok:true}}),webcrypto);
 await api.call('GET','/fapi/v1/order',{symbol,origClientOrderId:'never-export-this-id'});
 const value=JSON.stringify(api.timings);assert.ok(!value.includes('never-export'));assert.ok(!value.includes('signature'));assert.ok(api.timings.every(t=>Number.isFinite(t.ms)));
});
test('a manual command queued during entry checks prevents new order dispatch',async()=>{
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(...args)=>{const result=await base(...args);if(args[1]==='/fapi/v1/ticker/bookTicker')f.e.controlPending=true;return result;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/Manual action queued/);
});
test('a signal that expires during leverage checks is not submitted',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const f=fixture();f.e.newRules=true;const base=f.api.call;
 f.api.call=async(...args)=>{const result=await base(...args);if(args[1]==='/fapi/v1/leverage')clock+=400000;return result;};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/became stale/);assert.equal(f.e.auto,true);
});


for(const side of ['BUY','SELL'])test('continuing '+side+' momentum enters without a 20-candle breakout, with $300 initial margin and current exit policy',async()=>{
 const {momentumSetup}=require('./engine.js'),at=Date.now(),raw=continuationBars(side,60000,at),trend=continuationBars(side,300000,at);
 assert.equal(breakout(raw,at,60000),null);
 const signal=momentumSetup(raw,trend,at);assert.equal(signal.side,side);assert.equal(signal.setupType,'momentum');
 const f=fixture();f.e.newRules=true;f.signal.side=side;f.e.marketContext.side=side;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?raw:original(m,p,q,s);
 await f.e.enter(symbol,{...signal,exitPolicy:'manual-profit-60s-loss'});
 const record=f.e.active()[0];assert.ok(record);assert.equal(record.estimatedEntryMargin,300);assert.ok(record.leverage<=10);
 assert.equal(record.lossLimit,5);assert.ok(record.exitsReady);assert.equal(record.entryEvidence.marketContext.side,side);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('moderate confirmed momentum is accepted at no more than 3x',async()=>{
 const {momentumSetup}=require('./engine.js'),at=Date.now(),raw=continuationBars('BUY',60000,at),trend=continuationBars('BUY',300000,at);
 Object.assign(raw.at(-1),{1:99.8,2:100.1,3:99.7});
 const signal=momentumSetup(raw,trend,at);assert.ok(signal);assert.equal(signal.strength,1);
 const f=fixture();f.e.newRules=true;await f.e.enter(symbol,{...signal,exitPolicy:'manual-profit-60s-loss'});
 assert.ok(f.e.active()[0].leverage<=3);assert.equal(f.e.active()[0].estimatedEntryMargin,300);
});
for(const side of ['BUY','SELL'])test('momentum '+side+' skips reversal, opposite trend, thin volume, stale and malformed candles',()=>{
 const {momentumSetup}=require('./engine.js'),at=Date.now(),raw=continuationBars(side,60000,at),trend=continuationBars(side,300000,at);
 assert.equal(momentumSetup(raw,continuationBars(side==='BUY'?'SELL':'BUY',300000,at),at),null);
 const reversed=structuredClone(raw);reversed.at(-1)[1]=side==='BUY'?100.04:99.96;
 assert.equal(momentumSetup(reversed,trend,at),null);
 const thin=structuredClone(raw);thin.at(-1)[5]=1;assert.equal(momentumSetup(thin,trend,at),null);
 assert.equal(momentumSetup(raw,trend,at+120000),null);
 const malformed=structuredClone(raw);malformed.at(-1)[1]=500;assert.throws(()=>momentumSetup(malformed,trend,at),/open/);
 const gap=structuredClone(raw);gap[12][0]+=1;assert.throws(()=>momentumSetup(gap,trend,at),/candles/);
});
test('a single outsized candle is not chased by momentum setup',()=>{
 const {momentumSetup}=require('./engine.js'),at=Date.now(),raw=continuationBars('BUY',60000,at),trend=continuationBars('BUY',300000,at);
 Object.assign(raw.at(-1),{1:99.7,2:115.1,3:99.6,4:115,5:100});let reason;
 assert.equal(momentumSetup(raw,trend,at,60000,r=>reason=r),null);assert.match(reason,/extended/);
});
test('leverage tiers use observed agreement and market context, never exceed 10x',()=>{
 const {signalLeverageCeiling,adaptiveLeveragePlan}=require('./engine.js'),at=Date.now();
 for(const side of ['BUY','SELL'])for(const [strength,ceiling] of [[1,3],[2,5],[3,10],[100,10]]){
  const signal={side,strength};assert.equal(signalLeverageCeiling(signal,{side,closedAt:at-1000},at),ceiling);
  assert.ok(signalLeverageCeiling(signal,{side:side==='BUY'?'SELL':'BUY',closedAt:at-1000},at)<=3);
  assert.ok(signalLeverageCeiling(signal,{side,closedAt:at-400000},at)<=3);
  assert.ok(signalLeverageCeiling(signal,null,at)<=3);
 }
 assert.throws(()=>adaptiveLeveragePlan({price:100,atr:.1,fee:.0001,lossLimit:8,side:'BUY',tick:'.01',plan:l=>({qty:l*3}),maxLeverage:11}),/ceiling/);
});
test('market context is fresh closed BTC data, cached and unavailable conservatively',async()=>{
 const f=fixture();f.e.newRules=true;f.e.marketCheckedAt=0;let reads=0;
 f.api.call=async(m,p,q,s)=>{assert.equal(m,'GET');assert.equal(p,'/fapi/v1/klines');assert.equal(s,false);assert.equal(q.symbol,'BTCUSDT');assert.equal(q.interval,'5m');reads++;return continuationBars('SELL',300000);};
 await f.e.refreshMarketContext();assert.equal(f.e.marketContext.side,'SELL');await f.e.refreshMarketContext();assert.equal(reads,1);
 f.e.marketCheckedAt=0;f.e.candleCache.clear();f.api.call=async()=>{throw new DemoError('offline');};
 await f.e.refreshMarketContext();assert.equal(f.e.marketContext.side,null);assert.match(f.e.marketContext.reason,/offline/);assert.equal(f.e.auto,true);
});
for(const side of ['BUY','SELL'])test('scanner reaches a momentum-only '+side+' entry from movers',async()=>{
 const f=fixture();f.e.newRules=true;f.e.symbols=[symbol];f.e.moversCheckedAt=Date.now();f.e.movers=[{symbol,side,change:side==='BUY'?10:-10}];f.e.marketContext.side=side;f.signal.side=side;
 const original=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?continuationBars(side,q.interval==='5m'?300000:60000):original(m,p,q,s);
 await f.e.scan();const r=f.e.active()[0];assert.ok(r);assert.equal(r.side,side);assert.equal(r.signal.setupType,'momentum');assert.equal(r.estimatedEntryMargin,300);assert.ok(r.exitsReady);
 assert.equal(f.e.scanned[0].phase,'Order submitted');assert.match(f.e.scanned[0].source,side==='BUY'?/Gainer/:/Loser/);
});

test('longer-timeframe candidate is considered when first setup cannot clear commission',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.intervalMs=60000;f.signal.atr=.1;
 f.signal.alternatives=[{...f.signal,intervalMs:300000,atr:2,close:Math.floor(Date.now()/300000)*300000-1}];
 await f.e.enter(symbol,f.signal);const record=f.e.active()[0];assert.ok(record,'A fee-viable 5m candidate was discarded after the 1m setup failed');
 assert.equal(record.signal.intervalMs,300000);assert.ok(record.exitsReady);assert.equal(record.estimatedEntryMargin,300);
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/order'&&c.method==='POST'&&!c.p.reduceOnly).length,1);
});
test('5m fee-viable setup does not require its confirming 1m candle to pay the whole trade cost',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.intervalMs=300000;const original=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars('BUY',Date.now(),.1):original(m,p,q,s);
 await f.e.enter(symbol,f.signal);const record=f.e.active()[0];assert.ok(record,'Directional 1m confirmation was incorrectly treated as the 5m profit horizon');assert.ok(record.exitsReady);assert.equal(record.lossLimit,5);
});

test('scanner retains qualifying later timeframes instead of ending after the first setup',async()=>{
 const f=fixture();f.e.newRules=true;
 f.api.call=async(m,p,q)=>scanBars('BUY',q.interval==='1m'?60000:300000,q.interval==='1m'?150:300);
 const result=await f.e.scanCandidate(symbol,{side:'BUY',change:10},f.e.stopEpoch,new AbortController());
 assert.ok(result.signal);assert.equal(result.checks.length,10);assert.ok(result.signal.alternatives.length>0);
 assert.ok(result.signal.alternatives.some(s=>s.intervalMs>60000));assert.ok(result.signal.alternatives.every(s=>s.side==='BUY'));
});
test('timeframe fallback never accepts stale, opposite, already-traded or fee-ineligible alternatives',()=>{
 const {selectEntryCandidate}=require('./engine.js'),f=fixture(),now=Date.now();
 const primary={...f.signal,intervalMs:60000,atr:.01};
 const variants=[{...f.signal,side:'SELL',intervalMs:300000},{...f.signal,intervalMs:300000,close:now-400000},{...f.signal,intervalMs:300000,close:now-10000}];
 const selected=selectEntryCandidate({...primary,alternatives:variants},{price:100,fee:.0005,now,traded:s=>s.close===now-10000});
 assert.equal(selected.signal,null);assert.equal(selected.checks.length,4);
 assert.match(selected.checks[0].reason,/commission/);assert.match(selected.checks[1].reason,/opposite/);assert.match(selected.checks[2].reason,/stale/);assert.match(selected.checks[3].reason,/Already traded/);
});
test('1m entries still must clear their own fresh volatility and commission screen',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.intervalMs=60000;const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars('BUY',Date.now(),.1):base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.active().length,0);assert.match(f.e.entryOutcome,/Recent 1m movement/);assert.equal(f.e.auto,true);
});
test('diagnostics explain zero entries without account reads or secret data',async()=>{
 const f=fixture();f.e.newRules=true;f.e.tradingReady=true;f.e.symbols=[symbol];f.e.moversCheckedAt=Date.now();f.e.api.key='PRIVATE_KEY';f.e.api.relayToken='PRIVATE_TOKEN';
 f.e.scanCandidate=async()=>({symbol,signal:null,reason:'No aligned candle momentum',intervalMs:60000,checks:[{minutes:1,reason:'No aligned candle momentum'}]});
 f.e.api.call=async()=>{throw Error('Diagnostics must not call Binance');};await f.e.scan();
 const d=f.e.scanDiagnostics(),text=JSON.stringify(d);assert.equal(d.scanAudit.checked,1);assert.equal(d.scanAudit.qualified,0);assert.equal(d.scanAudit.submitted,0);assert.match(d.status,/0 confirmed order submissions/);
 assert.match(text,/No aligned candle momentum/);assert.ok(!text.includes('PRIVATE_KEY'));assert.ok(!text.includes('PRIVATE_TOKEN'));assert.equal(f.e.state.records.length,0);
 f.e.connected=false;assert.match(f.e.scanDiagnostics().status,/Disconnected/);
 f.e.connected=true;f.e.auto=false;assert.match(f.e.scanDiagnostics().status,/Auto is stopped/);
 f.e.auto=true;f.e.state.goalStopAt=Date.now();assert.match(f.e.scanDiagnostics().status,/session stop is locked/);
});
test('diagnostics distinguish unresolved entry errors from skipped or accepted entries',()=>{
 const f=fixture();f.e.tradingReady=true;f.e.symbols=[symbol];
 f.e.recordScanResult({symbol,side:'BUY',phase:'Entry error',reason:'Unknown order status'});
 const d=f.e.scanDiagnostics();assert.equal(d.scanAudit.entryErrors,1);assert.equal(d.scanAudit.submitted,0);assert.equal(d.scanAudit.skipped,0);assert.match(d.status,/Unknown order status/);
});
test('diagnostics flag a scan with no completed checks for over 90 seconds',()=>{
 const f=fixture();f.e.tradingReady=true;f.e.symbols=[symbol];f.e.scanStats={startedAt:Date.now()-120000};
 assert.match(f.e.scanDiagnostics().status,/No completed coin check/);
});

for(const side of ['BUY','SELL'])test('bounded '+side+' quote movement and a small breakout retest can enter',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.side=side;f.signal.price=side==='BUY'?98.8:101.2;
 f.signal.high=side==='BUY'?100.1:110;f.signal.low=side==='SELL'?99.9:90;
 f.signal.exitPolicy='manual-profit-60s-loss';f.e.marketContext.side=side;
 await f.e.enter(symbol,f.signal);assert.ok(f.e.active()[0]?.exitsReady,'Small price movement was rejected');
 assert.equal(f.e.active()[0].lossLimit,5);
});
for(const path of ['/fapi/v1/commissionRate','/fapi/v1/premiumIndex','/fapi/v1/openOrders'])test('temporary entry read '+path+' skips only the candidate',async()=>{
 const f=fixture(),original=f.api.call;f.e.newRules=true;
 f.api.call=async(m,p,q,s)=>{if(m==='GET'&&p===path)throw new DemoError('Temporary read failure',0);return original(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.auto,true);assert.equal(f.e.state.records.length,0);assert.match(f.e.entryOutcome,/scanning continues/i);
});


for(const failure of ['read','price-band'])test(failure+' failure on one coin does not prevent the next qualifying entry',async()=>{
 const f=fixture(),base=f.api.call;f.e.newRules=true;const first='AAAUSDT';
 f.e.meta.set(first,f.e.meta.get(symbol));f.e.symbols=[first,symbol];f.e.moversCheckedAt=Date.now();
 f.e.scanCandidate=async s=>({symbol:s,signal:{...f.signal},intervalMs:300000,scanMs:0});
 f.api.call=async(m,p,q={},s)=>{
  if(q.symbol===first&&failure==='read'&&p==='/fapi/v1/commissionRate')throw new DemoError('Temporary read failure',503,true);
  if(q.symbol===first&&p==='/fapi/v1/ticker/bookTicker')return {...await base(m,p,q,s),symbol:first};
  if(q.symbol===first&&failure==='price-band'&&m==='POST'&&p==='/fapi/v1/order')throw new DemoError('Price band',-4131);
  return base(m,p,q,s);
 };
 await f.e.scan();assert.equal(f.e.auto,true);assert.ok(f.e.owned(symbol)?.exitsReady);
 assert.equal(f.e.scanned.find(r=>r.symbol===first).phase,'Entry skipped');
 assert.equal(f.e.scanAudit.submitted,1);assert.equal(f.e.scanAudit.skipped,1);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly).length,1);
});
for(const code of [-4016,-4024,-4131])test('definite price-filter rejection '+code+' is never blindly retried',async()=>{
 const f=fixture(),base=f.api.call;f.e.newRules=true;let sent=0;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'){sent++;throw new DemoError('Price filter',code);}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(sent,1);assert.equal(f.e.auto,true);assert.ok(f.e.state.records[0].rejected);assert.equal(f.e.active().length,0);
});
for(const code of [-2015,-1022,429,451])test('account-wide failure '+code+' is not treated as a tolerable entry read',async()=>{
 const f=fixture(),base=f.api.call;f.e.newRules=true;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/commissionRate')throw new DemoError('Account blocked',code);return base(m,p,q,s);};
 await assert.rejects(()=>f.e.enter(symbol,f.signal),e=>e.code===code);assert.equal(f.e.state.records.length,0);
});
for(const side of ['BUY','SELL'])test(side+' tolerance still rejects excess drift, a broken breakout and a momentum reversal',()=>{
 const {entryPriceReason}=require('./engine.js');const sign=side==='BUY'?1:-1;
 const s={side,price:100,atr:2,high:99.8,low:100.2};
 assert.equal(entryPriceReason(100+sign*1.5,s,{tolerant:true}),null);
 assert.match(entryPriceReason(100+sign*1.51,s,{tolerant:true}),/too far/);
 const boundary=side==='BUY'?s.high:s.low;
 assert.equal(entryPriceReason(boundary-sign*.19,s,{tolerant:true}),null);
 assert.match(entryPriceReason(boundary-sign*.21,s,{tolerant:true}),/reversed/);
 assert.match(entryPriceReason(boundary,{...s,setupType:'momentum',invalidationPrice:boundary},{tolerant:true}),/reversed/);
 assert.match(entryPriceReason(NaN,s,{tolerant:true}),/Invalid/);
});

test('session close attempts every bot and finishes unresolved closes even after PnL drops below target',async()=>{
 const e=new DemoEngine({offset:0},{version:1,records:[{id:'bd1_a',symbol:'AAAUSDT',side:'BUY',entryStatus:'FILLED'},{id:'bd1_b',symbol:'BBBUSDT',side:'SELL',entryStatus:'FILLED'}],startedAt:Date.now()-1000},()=>{});
 e.auto=true;e.lastIncome=Date.now();e.income=[{income:'100'}];e.positions=[];
 const attempts=[];let failFirst=true;
 e.close=async(symbol)=>{attempts.push(symbol);if(symbol==='AAAUSDT'&&failFirst)throw new DemoError('Close unresolved');e.owned(symbol).closedAt=Date.now();};
 await assert.rejects(()=>e.enforceSessionGoal(),/closure needs reconciliation/);
 assert.deepEqual(attempts,['AAAUSDT','BBBUSDT']);assert.equal(e.active().length,1);assert.equal(e.auto,false);assert.ok(e.state.goalStopAt);
 failFirst=false;e.income=[{income:'70'}];await e.enforceSessionGoal();
 assert.deepEqual(attempts,['AAAUSDT','BBBUSDT','AAAUSDT']);assert.equal(e.active().length,0);assert.equal(e.auto,false);
});
test('unknown session close is queried on the next pass without a duplicate order',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;await f.e.enter(symbol,f.signal);f.failClose=true;
 f.e.income=[{income:'100'}];f.e.lastIncome=Date.now();
 await assert.rejects(()=>f.e.enforceSessionGoal());assert.ok(f.e.active()[0].pendingClose);
 const sent=f.calls.filter(c=>c.method==='POST'&&c.p.reduceOnly==='true').length;
 await assert.rejects(()=>f.e.enforceSessionGoal());assert.equal(f.calls.filter(c=>c.method==='POST'&&c.p.reduceOnly==='true').length,sent);
 assert.ok(f.e.state.goalStopAt);assert.equal(f.e.auto,false);
});
test('tick observes the $100 session target before closing an individual positive-net winner',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.e.syncDaily=()=>{};f.e.state.dayOpenPnl=0;f.e.tradingReady=true;f.e.lastFullCheck=Date.now();
 f.position.unRealizedProfit='106';await f.e.refresh();f.e.income=[{income:'-6'}];f.e.lastIncome=Date.now();f.e.ensureIncomeFresh=async()=>{};
 await f.e.tick();assert.equal(f.e.state.goalNet,100);assert.equal(r.closeReason,'$100 net session target');assert.equal(f.e.active().length,0);assert.equal(f.e.auto,false);
});
test('Start accepts a reconciled position with the new loss stop',async()=>{
 const f=fixture();f.e.newRules=true;f.e.tradingReady=true;await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 f.e.pause();await f.e.start();assert.equal(f.e.auto,true);assert.equal(r.protected,true);assert.equal(r.exitsReady,true);
});
test('session goal confirms cancellation of partial entry before closing the filled position',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;await f.e.enter(symbol,f.signal);const r=f.e.active()[0],base=f.api.call;
 r.entryStatus='PARTIALLY_FILLED';let cancelled=false;const before=f.calls.length;
 f.api.call=async(m,p,q,s)=>{
  if(p==='/fapi/v1/order'&&m==='GET'&&q.origClientOrderId===r.id)return {status:cancelled?'CANCELED':'PARTIALLY_FILLED',orderId:r.orderId,executedQty:r.quantity};
  if(p==='/fapi/v1/order'&&m==='DELETE')cancelled=true;
  if(p==='/fapi/v1/order'&&m==='POST'&&q.reduceOnly)assert.ok(cancelled);
  return base(m,p,q,s);
 };
 f.e.income=[{income:'100'}];f.e.lastIncome=Date.now();await f.e.enforceSessionGoal();
 const calls=f.calls.slice(before);assert.ok(calls.findIndex(c=>c.method==='DELETE'&&c.path==='/fapi/v1/order')<calls.findIndex(c=>c.method==='POST'&&c.p.reduceOnly));
 assert.equal(f.e.active().length,0);assert.equal(f.e.auto,false);
});
test('unresolved entry cancellation remains journaled at the session goal instead of falsely reporting flat',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;await f.e.enter(symbol,f.signal);const r=f.e.active()[0],base=f.api.call,before=f.calls.length;
 r.entryStatus='PARTIALLY_FILLED';f.api.call=async(m,p,q,s)=>{
  if(p==='/fapi/v1/order'&&m==='GET'&&q.origClientOrderId===r.id)return {status:'PARTIALLY_FILLED',orderId:r.orderId};
  return base(m,p,q,s);
 };
 f.e.income=[{income:'100'}];f.e.lastIncome=Date.now();await assert.rejects(()=>f.e.enforceSessionGoal(),/unresolved/);
 assert.equal(f.e.active().length,1);assert.equal(r.closedAt,undefined);assert.equal(f.e.auto,false);assert.ok(f.e.state.goalStopAt);
 assert.ok(!f.calls.slice(before).some(c=>c.method==='POST'));
});
test('session completion waits for confirmed flat positions after a close acknowledgement',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;await f.e.enter(symbol,f.signal);const close=f.e.close.bind(f.e);
 f.e.income=[{income:'100'}];f.e.lastIncome=Date.now();f.e.close=async()=>{};
 await assert.rejects(()=>f.e.enforceSessionGoal(),/awaiting flat position confirmation/);assert.equal(f.e.auto,false);assert.equal(f.e.active().length,1);
 f.e.income=[{income:'90'}];f.e.close=close;await f.e.enforceSessionGoal();assert.equal(f.e.active().length,0);assert.match(f.e.block,/positions closed/);
});
test('new short has a loss stop and closes at the session target',async()=>{
 const f=fixture();f.e.estimateSessionClose=async()=>100;f.e.newRules=true;f.signal.side='SELL';f.signal.low=101;f.e.marketContext.side='SELL';
 await f.e.enter(symbol,f.signal);const r=f.e.active()[0];
 assert.ok([...f.algos.values()].every(a=>a.type==='STOP_MARKET'&&a.clientAlgoId.length<=36));
 f.e.income=[{income:'100'}];f.e.lastIncome=Date.now();await f.e.enforceSessionGoal();
 assert.equal(f.e.active().length,0);assert.equal(f.e.auto,false);assert.equal(r.closeReason,'$100 net session target');
 assert.ok([...f.algos.values()].every(a=>a.algoStatus==='CANCELED'));
});


async function currentTrade(side='BUY'){
 const f=fixture();f.e.newRules=true;f.signal.side=side;f.e.marketContext.side=side;if(side==='SELL')f.signal.low=101;
 await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol));return f;
}
test('net profit ladder uses 2,4,6,8,10 then five-dollar steps, strictly after crossing',()=>{
 const {netProfitFloor}=require('./engine.js');
 for(const [peak,floor] of [[-1,null],[0,null],[1,null],[2,null],[2.01,2],[4,2],[4.01,4],[6,4],[6.01,6],[8,6],[8.01,8],[10,8],[10.01,10],[15,10],[15.01,15],[20,15],[20.01,20],[27,25],[100,95],[100.01,100]])assert.equal(netProfitFloor(peak),floor);
});
for(const side of ['BUY','SELL'])test(side+' rising net profit is held; pullback closes at an armed floor after fees',async()=>{
 const f=await currentTrade(side),r=f.e.owned(symbol);
 for(const target of [.5,1,2,3,4.1,6.1,8.1,10.1,15.1,20.1,25.1]){setTradeNet(f,target);await f.e.reconcile();assert.ok(f.position,'Closed rising profit at '+target);}
 assert.equal(r.profitFloor,25);setTradeNet(f,25);await f.e.reconcile();assert.equal(f.position,null);assert.equal(r.closeReason,'Net profit trailing pullback');
 const actual=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(actual-25)<1e-6);
});
for(const side of ['BUY','SELL'])test(side+' loss trims once at -$3, then closes remainder at -$5 including booked loss',async()=>{
 const f=await currentTrade(side),r=f.e.owned(symbol),initial=Number(r.quantity);
 for(const net of [-1,-2.99]){setTradeNet(f,net);await f.e.reconcile();assert.equal(reductionPosts(f).length,0);}
 setTradeNet(f,-3);await f.e.reconcile();assert.equal(reductionPosts(f).length,1);assert.equal(r.lossReduction.status,'DONE');assert.equal(r.filledQty,initial*.75);
 setTradeNet(f,-4);await f.e.reconcile();assert.equal(reductionPosts(f).length,1);assert.ok(f.position);
 setTradeNet(f,-5);await f.e.reconcile();assert.equal(f.position,null);assert.equal(r.closeReason,'$5 net trade loss');assert.equal(f.e.auto,true);
 const actual=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(actual+5)<1e-6);
});
test('a jump past both loss thresholds closes fully without a 25% reduction first',async()=>{
 const f=await currentTrade();setTradeNet(f,-8);await f.e.reconcile();assert.equal(f.position,null);assert.equal(reductionPosts(f).length,0);assert.equal(f.e.auto,true);
});
test('new entry has a fee-aware exchange $5 stop and no premature fee-only trim',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),stop=r.exits.find(e=>!e.cancelled),q=Number(r.quantity),px=Number(stop.triggerPrice);
 assert.equal(stop.kind,'sl5');assert.equal(f.algos.get(stop.id).type,'STOP_MARKET');assert.equal(f.algos.get(stop.id).closePosition,'true');assert.equal(reductionPosts(f).length,0);
 const net=r.tradeAccounting.bookedNet+(px-r.entry)*q-q*px*r.fee;assert.ok(net>=-5-1e-6&&net<-4.7);assert.equal(r.lossLimit,5);assert.equal(r.rulesVersion,8);
});
test('after a trim, updated stop accounts for booked losses and is accepted before old stop is cancelled',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),old=r.exits.find(e=>!e.cancelled),start=f.calls.length;
 setTradeNet(f,-3.2);await f.e.reconcile();const latest=r.exits.find(e=>!e.cancelled);assert.notEqual(latest.id,old.id);assert.ok(latest.id.length<=36);
 const calls=f.calls.slice(start),add=calls.findIndex(c=>c.method==='POST'&&c.p.clientAlgoId===latest.id),remove=calls.findIndex(c=>c.method==='DELETE'&&String(c.p.algoId)===old.algoId);assert.ok(add>=0&&remove>add);
 const qty=Math.abs(Number(f.position.positionAmt)),px=Number(latest.triggerPrice),net=r.tradeAccounting.bookedNet+(px-r.entry)*qty-qty*px*r.fee;assert.ok(net>=-5-1e-6&&net<-4.7);
});
test('partial-close losses cannot disappear when the remaining position turns green',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,-3.2);await f.e.reconcile();setTradeNet(f,1);await f.e.reconcile();
 assert.equal(r.netEstimate,1);assert.equal(r.profitFloor,null);assert.ok(f.position);assert.ok(r.closingEstimate.realized<0);assert.ok(r.closingEstimate.paidCommission>0);
 setTradeNet(f,3);await f.e.reconcile();setTradeNet(f,2);await f.e.reconcile();assert.equal(f.position,null);
 const net=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(net-2)<1e-6);
});
test('actual opening commission overrides the original fee estimate without double-counting',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);f.trades[0].commission='3';r.tradeAccounting=null;setTradeNet(f,2.5);await f.e.reconcile();
 assert.equal(r.netEstimate,2.5);assert.equal(r.closingEstimate.paidCommission,3);assert.equal(r.profitFloor,2);assert.ok(f.position);
});
test('funding is included in total net and not treated as a fee-free profit',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,3);f.e.income=[{symbol,incomeType:'FUNDING_FEE',income:'-2',asset:'USDT',time:Date.now()}];f.e.incomeWindowStart=r.at;f.e.incomeWindowEnd=Date.now();r.tradeAccounting=null;
 await f.e.reconcile();assert.equal(r.netEstimate,1);assert.equal(r.closingEstimate.funding,-2);assert.equal(r.profitFloor,null);assert.ok(f.position);
});
test('profit pullback rechecks fees and never deliberately sends a sub-$2 profit close',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,3);await f.e.reconcile();setTradeNet(f,1.5);await f.e.reconcile();assert.ok(f.position);assert.equal(r.profitFloor,2);
 setTradeNet(f,2);await f.e.reconcile();assert.equal(f.position,null);
});
test('after a gap below the profit minimum the $5 loss exit still works',async()=>{
 const f=await currentTrade();setTradeNet(f,3);await f.e.reconcile();setTradeNet(f,-5.5);await f.e.reconcile();assert.equal(f.position,null);assert.equal(f.e.state.records[0].closeReason,'$5 net trade loss');
});
test('new high during final profit recheck cancels a premature close',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,5);await f.e.reconcile();setTradeNet(f,4);const base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/ticker/bookTicker'&&++reads===2){setTradeNet(f,7);return f.api.call(m,p,q,s);}return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.equal(r.profitFloor,6);
});
for(const version of [2,3,4,5,6,7])test('rules '+version+' migrate to the new stop without resetting a prior reduction',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);r.rulesVersion=version;r.lossReduction={status:'DONE',executedQty:0};r.trailPeak=999;r.profitFloor=995;
 await f.e.reconcile();assert.equal(r.rulesVersion,8);assert.equal(r.exitPolicy,'net-trailing');assert.equal(r.profitFloor,null);assert.equal(r.lossReduction.status,'DONE');assert.ok(r.protected);
});
test('trail and one-time reduction persist across restart',async()=>{
 const f=await currentTrade();setTradeNet(f,-3.2);await f.e.reconcile();setTradeNet(f,7);await f.e.reconcile();
 const restored=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});restored.bandRules=false;restored.meta=f.e.meta;await restored.refresh();await restored.reconcile();assert.equal(restored.owned(symbol).profitFloor,6);assert.equal(reductionPosts(f).length,1);
 setTradeNet(f,6);await restored.refresh();await restored.reconcile();assert.equal(f.position,null);
});
for(const kind of ['missing','mismatch','currency'])test(kind+' execution accounting defers profit exits rather than assuming zero costs',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,10);const base=f.api.call;r.tradeAccounting=null;
 if(kind==='currency')f.trades[0].commissionAsset='BNB';
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/userTrades'&&kind==='missing'?[]:p==='/fapi/v1/userTrades'&&kind==='mismatch'?(await base(m,p,q,s)).map(t=>({...t,qty:String(Number(t.qty)/2)})):base(m,p,q,s);
 await f.e.reconcile();assert.ok(f.position);assert.equal(r.netEstimate,null);assert.ok(r.estimateError);assert.equal(r.profitFloor,null);assert.ok(r.exits.some(e=>e.kind==='sl5'&&!e.cancelled));
});
for(const extra of [{time:Date.now()-20000},{bidPrice:'NaN'},{symbol:'WRONGUSDT'},{bidPrice:'102',askPrice:'101'}])test('invalid or stale closing quote never fabricates a profit '+JSON.stringify(extra),async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);closingQuote(f,101,extra);await f.e.reconcile();assert.ok(f.position);assert.equal(r.netEstimate,null);assert.match(r.estimateError,/invalid|stale/);
});
for(const side of ['BUY','SELL'])test(side+' estimate weights depth and deducts actual paid and expected closing fees',async()=>{
 const f=await currentTrade(side),r=f.e.owned(symbol),qty=Math.abs(Number(f.position.positionAmt)),base=f.api.call,first=side==='BUY'?102:98,second=side==='BUY'?101:99;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:first,askPrice:first,bidQty:qty/2,askQty:qty/2,time:Date.now()}:p==='/fapi/v1/depth'?{T:Date.now(),bids:[[first,qty/2],[second,qty/2]],asks:[[first,qty/2],[second,qty/2]]}:base(m,p,q,s);
 const net=await f.e.closingEstimate(r,f.position),px=(first+second)/2;
 assert.ok(Math.abs(net-(r.tradeAccounting.bookedNet+(px-100)*qty*(side==='BUY'?1:-1)-qty*px*r.fee))<1e-7);assert.equal(r.closingEstimate.source,'20-level depth');
});
test('insufficient depth prevents a fabricated full-position profit',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'101',askPrice:'101',bidQty:'.001',askQty:'.001',time:Date.now()}:p==='/fapi/v1/depth'?{T:Date.now(),bids:[[101,.001]]}:base(m,p,q,s);
 await f.e.reconcile();assert.ok(f.position);assert.match(r.estimateError,/depth/);assert.equal(r.netEstimate,null);
});
test('unknown 25% reduction is never resent after reload and blocks other closes until resolved',async()=>{
 const f=await currentTrade();setTradeNet(f,-3.2);f.failClose=true;await assert.rejects(()=>f.e.reconcile(),e=>e.uncertain);const r=f.e.owned(symbol),sent=reductionPosts(f).length;
 const restored=new DemoEngine(f.api,structuredClone(f.e.state),()=>{});restored.bandRules=false;restored.meta=f.e.meta;await restored.refresh();await assert.rejects(()=>restored.reconcile());await assert.rejects(()=>restored.close(symbol));assert.equal(reductionPosts(f).length,sent);
 f.failClose=false;f.orders.set(r.lossReduction.id,{status:'CANCELED',executedQty:'0'});await restored.close(symbol);assert.equal(f.position,null);assert.equal(reductionPosts(f).length,sent);
});
test('accepted trim with lost response reconciles one client ID and never repeats',async()=>{
 const f=await currentTrade();setTradeNet(f,-3.2);const base=f.api.call;
 f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(m==='POST'&&p==='/fapi/v1/order'&&q.newClientOrderId?.endsWith('_r'))throw new DemoError('Timeout',0,true);return result;};
 await f.e.reconcile();await f.e.reconcile();assert.equal(reductionPosts(f).length,1);assert.equal(f.e.owned(symbol).lossReduction.status,'DONE');
});
test('definite trim rejection is not repeated and does not halt other trading',async()=>{
 const f=await currentTrade();setTradeNet(f,-3.2);const base=f.api.call;let attempts=0;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'&&q.newClientOrderId?.endsWith('_r')){attempts++;throw new DemoError('Rejected',-2022);}return base(m,p,q,s);};
 await f.e.reconcile();await f.e.reconcile();assert.equal(attempts,1);assert.equal(f.e.owned(symbol).lossReduction.status,'REJECTED');assert.equal(f.e.auto,true);
});
test('manual close cancels partial reduction remainder before its full exit',async()=>{
 const f=await currentTrade();setTradeNet(f,-3.2);const base=f.api.call;let id;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'&&q.newClientOrderId?.endsWith('_r')){id=q.newClientOrderId;const o=await base(m,p,{...q,quantity:String(Number(q.quantity)/2)},s);o.status='PARTIALLY_FILLED';return o;}return base(m,p,q,s);};
 await assert.rejects(()=>f.e.reconcile());const before=f.calls.length;await f.e.close(symbol);const calls=f.calls.slice(before);
 assert.ok(calls.findIndex(c=>c.method==='DELETE'&&c.p.origClientOrderId===id)<calls.findIndex(c=>c.method==='POST'&&c.p.newClientOrderId?.endsWith('_c')));assert.equal(f.position,null);assert.equal(reductionPosts(f).length,1);
});
test('a fee increase on final recheck can prevent a supposedly profitable exit',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,3);await f.e.reconcile();setTradeNet(f,2);const base=f.api.call;let queries=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades'&&++queries===1)f.trades[0].commission=String(Number(f.trades[0].commission)+1);return base(m,p,q,s);};
 await f.e.reconcile();assert.ok(f.position);assert.equal(r.netEstimate,1);
});
test('$100 net close estimate reserves all remaining exit fees and uses actual execution costs',async()=>{
 const f=await currentTrade();f.e.income=[];f.e.lastIncome=Date.now();setTradeNet(f,99.99);await f.e.refresh();assert.ok(f.e.sessionNet()>100);
 assert.equal(await f.e.enforceSessionGoal(),false);assert.equal(f.e.sessionCloseEstimate.net,99.99);assert.ok(f.position);
 setTradeNet(f,100);await f.e.refresh();assert.equal(await f.e.enforceSessionGoal(),true);assert.equal(f.e.state.goalNet,100);assert.equal(f.position,null);assert.equal(f.e.auto,false);
 const actual=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);assert.ok(Math.abs(actual-100)<1e-6);
});
test('partial-close fees are not double-counted when Binance income has already posted them',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);setTradeNet(f,-3.2);await f.e.reconcile();setTradeNet(f,100);await f.e.refresh();
 f.e.income=f.trades.flatMap(t=>[{symbol,time:t.time,asset:'USDT',incomeType:'REALIZED_PNL',income:t.realizedPnl},{symbol,time:t.time,asset:'USDT',incomeType:'COMMISSION',income:String(-Number(t.commission))}]);f.e.lastIncome=Date.now();
 assert.equal(await f.e.estimateSessionClose(),100);assert.ok(r.tradeAccounting.commission>0);
});
test('failed stop replacement keeps the previous confirmed stop and can recover without cancelling it first',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),old=r.exits.find(e=>!e.cancelled);setTradeNet(f,-3.2);f.failProtection=true;
 await f.e.reconcile();assert.equal(reductionPosts(f).length,1);assert.equal(old.cancelled,undefined);assert.equal(f.algos.get(old.id).algoStatus,'NEW');assert.ok(r.estimateError);
 f.failProtection=false;await f.e.reconcile();const active=r.exits.filter(e=>!e.cancelled);assert.equal(active.length,1);assert.notEqual(active[0].id,old.id);assert.ok(active[0].confirmed);assert.equal(reductionPosts(f).length,1);
});
test('actual execution pagination neither misses nor duplicates paid commission',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),qty=Number(r.quantity),base=f.api.call;
 const rows=Array.from({length:1001},(_,i)=>({id:i+1,orderId:r.orderId,symbol,positionSide:'BOTH',side:'BUY',qty:String(qty/1001),price:'100',realizedPnl:'0',commission:'.001',commissionAsset:'USDT',time:Date.now()}));r.tradeAccounting=null;
 const requests=[];f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades'){requests.push(q);return rows.filter(t=>!q.fromId||t.id>=Number(q.fromId)).slice(0,1000);}return base(m,p,q,s);};
 const ledger=await f.e.tradeAccounting(r,f.position);assert.ok(Math.abs(ledger.commission-1.001)<1e-8);assert.ok(requests.some(q=>q.fromId==='1001'));assert.ok(requests.every(q=>!q.startTime&&!q.endTime));
});
test('a replacement manual position is not mistaken for the original bot trade',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol),qty=r.quantity;f.trades.push({...f.trades[0],id:2,orderId:2,side:'SELL',qty,commission:'0',realizedPnl:'1'},{...f.trades[0],id:3,orderId:3,qty});r.tradeAccounting=null;
 await assert.rejects(()=>f.e.tradeAccounting(r,f.position),/replaced outside/);
});
test('small position reduction respects quantity limits without forcing a full loss close',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);f.position.positionAmt='.003';f.trades[0].qty='.003';f.trades[0].commission='3.1';r.tradeAccounting=null;
 await f.e.refresh();await f.e.reconcile();assert.ok(f.position);assert.equal(r.lossReduction.status,'SKIPPED');assert.equal(reductionPosts(f).length,0);
});
test('an armed profit floor does not suppress the $3 trim after a reversal into loss',async()=>{
 const f=await currentTrade();setTradeNet(f,5);await f.e.reconcile();assert.equal(f.e.owned(symbol).profitFloor,4);
 setTradeNet(f,-3.2);await f.e.reconcile();assert.equal(reductionPosts(f).length,1);assert.ok(f.position);
 setTradeNet(f,-5);await f.e.reconcile();assert.equal(f.position,null);assert.equal(f.e.auto,true);
});

function armTrial(e){e.newRules=true;const at=Date.now()+e.api.offset;e.state.oneHourTrial={id:'trial_test',startedAt:at,until:at+3600000,scope:'new-positions',lossExit:'any-negative-net'};return e.state.oneHourTrial;}
function trialSignal(f){armTrial(f.e);return {...f.signal,oneHourTrial:f.e.state.oneHourTrial.id,intervalMs:60000};}
function smallPullbackBars(side='BUY',at=Date.now()){
 const bars=entryBars(side,at),last=bars.at(-1),previous=Number(bars.at(-2)[4]),sign=side==='BUY'?1:-1;
 const open=previous+.01*sign,close=previous-.02*sign;
 Object.assign(last,{1:open,2:Math.max(open,close)+.04,3:Math.min(open,close)-.04,4:close});return bars;
}
function entryPosts(f){return f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);}
test('trial starts once, persists exact hour, and refuses to extend on repeated clicks',async()=>{
 const f=fixture();f.e.newRules=true;f.e.start=async()=>{f.e.auto=true;};
 assert.equal(await f.e.startTrial(),true);const t={...f.e.state.oneHourTrial};assert.equal(t.until-t.startedAt,3600000);
 assert.equal(await f.e.startTrial(),false);assert.deepEqual(f.e.state.oneHourTrial,t);
 const reload=new DemoEngine(f.api,JSON.parse(JSON.stringify(f.e.state)),()=>{});reload.bandRules=false;assert.equal(reload.trialActive(t.until-1),true);assert.equal(reload.trialActive(t.until),false);assert.equal(reload.trialActive(t.startedAt-1),false);
 assert.equal(reload.entryPolicy.maxLeverage,150);assert.equal(reload.entryPolicy.lossLimit,6);
});
test('Stop during trial start checks prevents both auto and timer activation',async()=>{
 const f=fixture();f.e.newRules=true;let release;f.e.start=async()=>{await new Promise(r=>release=r);};
 const starting=f.e.startTrial();f.e.pause();release();assert.equal(await starting,false);assert.equal(f.e.state.oneHourTrial,undefined);assert.equal(f.e.auto,false);
});
test('trial countdown does not pause or restart with Stop/Resume and expiry never starts auto',async()=>{
 const f=fixture();const t=armTrial(f.e),until=t.until;f.e.pause();assert.equal(f.e.trialActive(),true);assert.equal(t.until,until);
 t.startedAt-=3600001;t.until-=3600001;f.e.expireTrial();assert.equal(f.e.trialActive(),false);assert.equal(f.e.auto,false);assert.ok(t.endedAt);
 const count=f.e.events.length;f.e.expireTrial();assert.equal(f.e.events.length,count);
});
test('trial adapts leverage to fees, sizes at most $300 and preserves the immediate negative-net exit',async()=>{
 const f=fixture(),signal=trialSignal(f);await f.e.enter(symbol,signal);
 const r=f.e.state.records[0];assert.ok(r);assert.equal(r.leverage,6);assert.ok(r.entryEvidence.estimatedRoundTripFees<=2);assert.equal(r.estimatedEntryMargin,300);assert.equal(r.exitPolicy,'trial-net-trailing');
 assert.ok(r.closedAt);assert.equal(r.closeReason,'Experiment negative net');assert.equal(entryPosts(f).length,1);assert.equal(f.e.auto,true);assert.equal(reductionPosts(f).length,0);
 assert.ok(f.trades.reduce((v,t)=>v+Number(t.realizedPnl)-Number(t.commission),0)<-1,'even reduced-leverage fees can exceed $1');
 assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/klines').length,1,'trial rechecks fresh momentum before configuring leverage');
});
test('trial leverage fallback finds account-supported maximum and keeps small capital valid',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{
  if(p==='/fapi/v1/leverage'&&q.leverage>17)throw new DemoError('limit',-4028);
  if(p==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'80',marginBalance:'5000'}],positions:[]};
  return base(m,p,q,s);
 };
 await f.e.enter(symbol,signal);const r=f.e.state.records[0];assert.equal(r.leverage,17);assert.ok(r.estimatedEntryMargin<=80&&r.estimatedEntryMargin>70);assert.ok(r.closedAt);
});
test('trial caps size to leverage notional capacity and does not increase margin above $300',async()=>{
 const f=fixture(),signal=trialSignal(f);lowVolatility(f);const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverage'?{leverage:q.leverage,maxNotionalValue:'1000'}:base(m,p,q,s);
 await f.e.enter(symbol,signal);const r=f.e.state.records[0];assert.equal(r.leverage,125);assert.equal(r.estimatedEntryMargin,8);assert.equal(Number(r.quantity)*100,1000);
});
test('trial expiry during leverage checks prevents a late entry dispatch',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{const out=await base(m,p,q,s);if(p==='/fapi/v1/leverage'){f.e.state.oneHourTrial.startedAt-=3600001;f.e.state.oneHourTrial.until-=3600001;}return out;};
 await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,0);assert.match(f.e.entryOutcome,/expired/);
});
test('trial uses same-candle deduplication but can trade a new candle without 10 minute cooldown',async()=>{
 const f=fixture(),signal=trialSignal(f);await f.e.enter(symbol,signal);await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,1);
 await f.e.enter(symbol,{...signal,close:signal.close+1});assert.equal(entryPosts(f).length,2);assert.equal(f.e.auto,true);
});
test('known trial entry rejection keeps scanning and unknown close remains journaled once',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'&&!q.reduceOnly)throw new DemoError('limit',-2027);return base(m,p,q,s);};
 await f.e.enter(symbol,signal);assert.equal(f.e.auto,true);assert.equal(f.e.state.records[0].rejected,true);
 const g=fixture(),next=trialSignal(g);g.failClose=true;await assert.rejects(()=>g.e.enter(symbol,next));const r=g.e.active()[0];assert.ok(r.pendingClose);assert.equal(g.e.auto,false);
 const id=r.pendingClose;await assert.rejects(()=>g.e.reconcile());assert.equal(r.pendingClose,id);assert.equal(entryPosts(g).length,1);
});
test('trial ladder doubles from 2 to 4 to 8, then 10 and increments of 5',()=>{
 const {trialProfitFloor}=require('./engine.js');
 for(const [peak,floor] of [[0,null],[2,null],[2.01,2],[4,2],[4.1,4],[6.5,4],[8,4],[8.1,8],[10,8],[10.1,10],[15,10],[15.1,15],[20,15],[20.1,20],[26,25]])assert.equal(trialProfitFloor(peak),floor);
});
test('trial leaves existing normal position policy unchanged and ends only new trial entries',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);armTrial(f.e);setTradeNet(f,1);await f.e.reconcile();assert.equal(r.rulesVersion,8);assert.equal(r.oneHourTrial,undefined);assert.equal(r.lossLimit,5);assert.ok(!r.closedAt);
 f.e.endTrial();assert.equal(f.e.trialActive(),false);assert.equal(f.e.auto,true);assert.equal(r.lossLimit,5);
});
for(const side of ['BUY','SELL'])test('trial '+side+' holds rising after-fee profit, replaces stop, and exits on ladder pullback',async()=>{
 const f=await currentTrade(side),r=f.e.owned(symbol);r.oneHourTrial={...armTrial(f.e)};r.rulesVersion=9;r.exitPolicy='trial-net-trailing';r.lossLimit=1;
 for(const value of [3,5,7,9,11,16,21]){setTradeNet(f,value);await f.e.reconcile();assert.ok(!r.closedAt,'hold '+value);}
 assert.equal(r.profitFloor,20);assert.ok(r.exits.some(e=>e.kind==='sl1'&&e.confirmed&&!e.cancelled));assert.ok(r.exits.filter(e=>e.kind==='sl5').every(e=>e.cancelled));
 f.e.endTrial();setTradeNet(f,20);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Experiment profit pullback');assert.equal(reductionPosts(f).length,0);
});
test('trial closes a tiny negative net without waiting 30 seconds and resets no normal loss counters',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);r.oneHourTrial={...armTrial(f.e)};r.rulesVersion=9;setTradeNet(f,-.01);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Experiment negative net');assert.equal(reductionPosts(f).length,0);assert.equal(f.e.auto,true);
});
test('trial negative exit rechecks total net and leaves a recovered position open',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);r.oneHourTrial={...armTrial(f.e)};r.rulesVersion=9;setTradeNet(f,3);
 assert.equal(await f.e.close(symbol,'Experiment negative net',{trialExit:true}),false);assert.ok(!r.closedAt);assert.equal(f.e.position(symbol).symbol,symbol);
});
test('trial loss checks retain actual commission accounting and unknown accounting is never reported as zero',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);r.oneHourTrial={...armTrial(f.e)};r.rulesVersion=9;setTradeNet(f,5);await f.e.reconcile();r.tradeAccounting=null;
 const base=f.api.call;f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades')return [];return base(m,p,q,s);};await f.e.reconcile();assert.equal(r.netEstimate,null);assert.ok(r.estimateError);assert.ok(!r.closedAt);assert.ok(r.exits.some(e=>e.kind==='sl1'&&e.confirmed&&!e.cancelled));
});
test('trial candidate requires mover alignment and confirms a setup past a doji',async()=>{
 const f=fixture();armTrial(f.e);const reads=[],minutes={'1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240};
 f.e.scanBars=async(_s,interval)=>{reads.push(interval);const b=continuationBars('SELL',minutes[interval]*60000);if(interval==='1m')b.at(-1)[1]=b.at(-1)[4];return b;};
 const aligned=await f.e.scanCandidate(symbol,{side:'SELL'},f.e.stopEpoch);assert.equal(aligned.signal.side,'SELL');assert.equal(aligned.signal.intervalMs,180000);assert.equal(aligned.signal.oneHourTrial,f.e.state.oneHourTrial.id);
 const opposite=await f.e.scanCandidate(symbol,{side:'BUY'},f.e.stopEpoch);assert.equal(opposite.signal,null);assert.ok(opposite.checks.some(c=>c.reason.includes('disagree')));
});
test('trial scanner ignores forming and stale candles, and supports all advertised intervals',async()=>{
 const f=fixture();armTrial(f.e);const reads=[];
 f.e.scanBars=async(_s,interval)=>{reads.push(interval);const ms=({'1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240})[interval]*60000;const bars=continuationBars('BUY',ms,Date.now()-ms*3);return bars;};
 const out=await f.e.scanCandidate(symbol,null,f.e.stopEpoch);assert.equal(out.signal,null);assert.equal(reads.length,8);
});
test('trial session profit still reserves closing costs and stops all bot entries at $100',async()=>{
 const f=await currentTrade(),r=f.e.owned(symbol);r.oneHourTrial={...armTrial(f.e)};r.rulesVersion=9;setTradeNet(f,101);f.e.lastIncome=Date.now();f.e.income=[];
 assert.equal(await f.e.enforceSessionGoal(),true);assert.ok(r.closedAt);assert.ok(f.e.state.goalStopAt);assert.equal(f.e.auto,false);
});

test('trial with no free margin skips without stopping the scanner',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v3/account'?{assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'0'}],positions:[]}:base(m,p,q,s);
 await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Waiting for available margin/);
});
test('short trial candle cache cannot replace longer normal-strategy history after expiry',async()=>{
 const f=fixture(),reads=[];f.api.call=async(m,p,q)=>{reads.push(q.limit);return scanBars('BUY',300000,q.limit);};
 await f.e.scanBars(symbol,'5m',30);const long=await f.e.scanBars(symbol,'5m',300);await f.e.scanBars(symbol,'5m',300);
 assert.deepEqual(reads,[30,300]);assert.equal(long.length,300);
});

for(const status of [400,404])test('bracket HTTP '+status+' falls back to confirmed 20x without stopping Auto or sending rejected trade orders',async()=>{
 const f=fixture(),signal=trialSignal(f);lowVolatility(f);const base=f.api.call;let bracketReads=0,probes=[];
 f.api.call=async(m,p,q,s)=>{
  if(p==='/fapi/v1/leverageBracket'){bracketReads++;throw new DemoError('route unavailable',status);}
  if(p==='/fapi/v1/leverage'){probes.push(q.leverage);if(q.leverage>20)throw new DemoError('invalid leverage',-4028);}
  return base(m,p,q,s);
 };
 await f.e.enter(symbol,signal);assert.equal(f.e.auto,true);assert.equal(f.e.state.records[0].leverage,20);assert.equal(entryPosts(f).length,1);assert.ok(probes.at(-1)===20);
 await f.e.enter(symbol,{...signal,close:signal.close+1});assert.equal(bracketReads,1);assert.equal(entryPosts(f).length,2);assert.equal(f.e.auto,true);
});
for(const code of [401,403,-2015,-1022,429])test('bracket authentication or rate failure '+code+' never starts fallback probes',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverageBracket')throw new DemoError('blocked',code);return base(m,p,q,s);};
 await assert.rejects(()=>f.e.enter(symbol,signal));assert.equal(entryPosts(f).length,0);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/leverage').length,0);
});
test('unavailable fee history blocks entry, retains Auto and clearly asks for old relay update',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;let reads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades'){reads++;const e=new DemoError('unsupported route',400);e.backendUpdateRequired=true;throw e;}return base(m,p,q,s);};
 await f.e.enter(symbol,signal);await f.e.enter(symbol,signal);assert.equal(reads,1);assert.equal(entryPosts(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/Update and restart/);
 f.api.call=base;f.e.accountingRetryAt=0;await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,1);assert.equal(f.e.accountingBlock,'');
});
test('trial skips inadequate movement after commission without querying leverage or stopping',async()=>{
 const f=fixture(),signal={...trialSignal(f),atr:.001};await f.e.enter(symbol,signal);
 assert.equal(entryPosts(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/commission/);assert.equal(f.calls.filter(c=>c.path==='/fapi/v1/leverage').length,0);
});
test('trial rechecks current direction and does not enter a reversed market',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars('SELL'):base(m,p,q,s);
 await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/momentum|movement|direction|revers/i);
});
test('trial rejects low-volume candles even when their direction is clear',async()=>{
 const f=fixture();armTrial(f.e);const minutes={'1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240};
 f.e.scanBars=async(_s,interval)=>{const b=continuationBars('BUY',minutes[interval]*60000);b.at(-1)[5]=1;return b;};
 const out=await f.e.scanCandidate(symbol,null,f.e.stopEpoch);assert.equal(out.signal,null);assert.ok(out.checks.some(c=>c.reason.includes('Volume')));
});
test('confirmed generic HTTP 400 entry rejection does not stop Auto or repeat a trade order',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;let dispatches=0;
 f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'&&!q.reduceOnly){dispatches++;throw new DemoError('entry rejected',400);}return base(m,p,q,s);};
 await f.e.enter(symbol,signal);assert.equal(dispatches,1);assert.equal(f.e.auto,true);assert.equal(f.e.state.records[0].rejected,true);
});
function recoveryFixture(){
 const f=fixture();f.e.newRules=true;f.e.tradingReady=true;f.e.syncDaily=()=>{};f.e.ensureIncomeFresh=async()=>{};f.e.enforceSessionGoal=async()=>false;f.e.reconcile=async()=>{};f.e.scanRiskCheck=async()=>{};f.e.reviewContinuation=async()=>{};f.e.refresh=async()=>{};return f;
}
test('temporary read failure retries automatically with backoff, refreshing before scanning',async()=>{
 const f=recoveryFixture();let scanned=0,refreshed=0;f.e.scan=async()=>scanned++;
 const error=new DemoError('network timeout',0);error.requestMethod='GET';error.requestPath='/fapi/v3/positionRisk';f.e.refresh=async()=>{throw error;};
 await f.e.tick();assert.equal(f.e.auto,true);assert.ok(f.e.retryAt>Date.now());assert.equal(scanned,0);const first=f.e.retryAt;
 await f.e.tick();assert.equal(f.e.retryAt,first);assert.equal(scanned,0);
 f.e.retryAt=0;f.e.refresh=async()=>refreshed++;await f.e.tick();assert.equal(refreshed,1);assert.equal(scanned,1);assert.equal(f.e.auto,true);assert.equal(f.e.retryAt,0);
});
test('read cooldown respects Binance deadline and explicit Stop cancels automatic resume',async()=>{
 const f=recoveryFixture();let scans=0;f.e.scan=async()=>scans++;const err=new DemoError('rate limit',429);err.requestMethod='GET';f.api.blockUntil=Date.now()+120000;f.e.refresh=async()=>{throw err;};
 await f.e.tick();assert.equal(f.e.auto,true);assert.ok(f.e.retryAt>=f.api.blockUntil);f.e.pause('User Stop');assert.equal(f.e.retryAt,0);
 f.e.refresh=async()=>{};await f.e.tick();assert.equal(f.e.auto,false);assert.equal(scans,0);
});
test('authentication and uncertain order writes never trigger automatic read recovery',async()=>{
 for(const [code,method,uncertain] of [[401,'GET',false],[-1022,'GET',false],[0,'POST',true],[500,'POST',true]]){
  const f=recoveryFixture(),err=new DemoError('requires review',code,uncertain);err.requestMethod=method;f.e.refresh=async()=>{throw err;};await f.e.tick();assert.equal(f.e.auto,false);assert.equal(f.e.retryAt,0);
 }
 const f=recoveryFixture(),err=new DemoError('read failed',0);err.requestMethod='GET';f.e.state.records=[{id:'bd1_pending',symbol,side:'BUY',pendingClose:'bd1_close',entryStatus:'FILLED'}];
 assert.equal(f.e.scheduleReadRecovery(err),false);
});
test('Stop during an in-flight read prevents error recovery from re-enabling Auto',async()=>{
 const f=recoveryFixture();let release;f.e.refresh=()=>new Promise((_,reject)=>{release=reject;});const tick=f.e.tick();f.e.pause('User Stop');const err=new DemoError('offline',0);err.requestMethod='GET';release(err);await tick;assert.equal(f.e.auto,false);assert.equal(f.e.retryAt,0);
});
test('API reports obsolete relay routes honestly and classifies read errors separately from writes',async()=>{
 const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode('unit-test-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const api=new DemoAPI('fake-key',key,async()=>Response.json({error:'Unsupported demo request'},{status:400}),webcrypto);api.synced=Date.now();api.relayToken='test-token';
 await assert.rejects(()=>api.call('GET','/fapi/v1/leverageBracket',{symbol}),e=>e.code===400&&e.backendUpdateRequired&&e.source==='local-backend'&&e.requestMethod==='GET'&&!e.uncertain&&/Local backend/.test(e.message));
 api.relayToken='';api.fetcher=async()=>Response.json({code:500},{status:500});await assert.rejects(()=>api.call('GET','/fapi/v3/account'),e=>e.requestMethod==='GET'&&!e.uncertain);
 await assert.rejects(()=>api.call('POST','/fapi/v1/order',{symbol}),e=>e.requestMethod==='POST'&&e.uncertain);
});

test('trial keeps a later qualified timeframe when the primary candle was already traded',async()=>{
 const f=fixture(),signal=trialSignal(f);await f.e.enter(symbol,signal);const later={...signal,close:signal.close-1000,intervalMs:180000};
 await f.e.enter(symbol,{...signal,alternatives:[later]});assert.equal(entryPosts(f).length,2);assert.equal(f.e.state.records[1].signal.intervalMs,180000);
});

for(const side of ['BUY','SELL'])test(side+' longer setup tolerates a small counter candle, but 1m still requires alignment',()=>{
 const {entryConfirmation}=require('./engine.js'),at=Date.now(),bars=smallPullbackBars(side,at);
 assert.match(entryConfirmation(bars,{side,intervalMs:60000},at).reason,/no longer confirms/);
 for(const minutes of [3,5,15,30,60,120,240]){
  const result=entryConfirmation(bars,{side,intervalMs:minutes*60000},at);assert.equal(result.reason,null);assert.ok(result.atr>0);assert.equal(result.signalMinutes,minutes);
 }
 const stale=entryConfirmation(bars,{side,intervalMs:3600000},at+180000);assert.match(stale.reason,/stale/);
 const bad=structuredClone(bars);bad[12][0]++;assert.throws(()=>entryConfirmation(bad,{side,intervalMs:3600000},at),/candles/);
});
for(const side of ['BUY','SELL'])test(side+' longer setup still rejects a sharp counter candle and sustained reversal',()=>{
 const {entryConfirmation}=require('./engine.js'),at=Date.now(),bars=smallPullbackBars(side,at),last=bars.at(-1),sign=side==='BUY'?1:-1;
 const open=Number(last[1]),close=open-sign;Object.assign(last,{2:Math.max(open,close)+.05,3:Math.min(open,close)-.05,4:close});
 assert.match(entryConfirmation(bars,{side,intervalMs:3600000},at).reason,/reversal/);
 assert.match(entryConfirmation(entryBars(side==='BUY'?'SELL':'BUY',at),{side,intervalMs:3600000},at).reason,/reversal/);
});
for(const trial of [false,true])for(const side of ['BUY','SELL'])test((trial?'trial':'normal')+' '+side+' checks the later timeframe after strict 1m rejection and submits one order',async()=>{
 const f=fixture();f.e.newRules=true;f.signal.side=side;const primary=trial?trialSignal(f):{...f.signal,intervalMs:60000};
 if(side==='SELL'){primary.low=101;primary.high=110;}
 const later={...primary,intervalMs:900000,close:Math.floor(Date.now()/900000)*900000-1,high:99,low:101};
 const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?smallPullbackBars(side):base(m,p,q,s);
 f.e.scanned=[{symbol,checks:[]}];await f.e.enter(symbol,{...primary,alternatives:[later]});
 assert.equal(entryPosts(f).length,1);const r=f.e.state.records[0];assert.equal(r.signal.intervalMs,900000);assert.equal(r.side,side);
 assert.match(r.entryEvidence.candidateChecks[0].reason,/no longer confirms/);assert.equal(r.entryEvidence.candidateChecks.at(-1).reason,'Entry candidate selected');
 assert.equal(f.e.scanned[0].candleClosedAt,later.close);assert.equal(f.e.auto,true);
});
for(const side of ['BUY','SELL'])test('trial finds independent 15m '+side+' setup when 5m confirmation is opposite',async()=>{
 const f=fixture();armTrial(f.e);const opposite=side==='BUY'?'SELL':'BUY',minutes={'1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240};
 f.e.scanBars=async(_s,interval)=>continuationBars(minutes[interval]<=5?opposite:side,minutes[interval]*60000);
 const out=await f.e.scanCandidate(symbol,{side,change:5},f.e.stopEpoch);assert.ok(out.signal);assert.equal(out.signal.side,side);assert.equal(out.signal.intervalMs,900000);assert.equal(out.checks.length,8);
});
test('high leverage remains available only when fees, volatility and exchange ceiling permit it',async()=>{
 const f=fixture(),signal=trialSignal(f);lowVolatility(f);const base=f.api.call;
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:150}]}:base(m,p,q,s);
 await f.e.enter(symbol,signal);const r=f.e.state.records[0];assert.equal(r.leverage,150);assert.ok(r.entryEvidence.estimatedRoundTripFees<=2);assert.ok(r.entryEvidence.estimatedLossAtOneAtr<=20);assert.equal(r.estimatedEntryMargin,300);
});
test('unsupported old connector is shown as the primary blocker and rechecks without other entry reads',async()=>{
 const f=fixture(),signal=trialSignal(f),base=f.api.call;let feeReads=0;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades'){feeReads++;const error=new DemoError('old relay',400);error.backendUpdateRequired=true;throw error;}return base(m,p,q,s);};
 await f.e.enter(symbol,signal);await f.e.enter(symbol,signal);assert.equal(feeReads,1);assert.equal(f.calls.length,0);assert.equal(f.e.auto,true);assert.equal(f.e.accountingUpdateRequired,true);assert.match(f.e.scanDiagnostics().status,/CONNECTOR UPDATE REQUIRED/);
 f.e.accountingRetryAt=0;f.api.call=base;await f.e.enter(symbol,signal);assert.equal(entryPosts(f).length,1);assert.equal(f.e.accountingUpdateRequired,false);
});
