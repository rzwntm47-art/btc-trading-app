'use strict';
const DEMO_BASE = 'https://demo-fapi.binance.com';
const PUBLIC = new Set(['/fapi/v1/time','/fapi/v1/exchangeInfo','/fapi/v1/klines','/fapi/v1/ticker/24hr','/fapi/v1/premiumIndex','/fapi/v1/assetIndex']);
const PRIVATE = {
  GET: new Set(['/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/positionSide/dual','/fapi/v1/multiAssetsMargin','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/commissionRate','/fapi/v1/income']),
  POST: new Set(['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/leverage','/fapi/v1/marginType']),
  DELETE: new Set(['/fapi/v1/algoOrder','/fapi/v1/order'])
};
class DemoError extends Error { constructor(message, code=0, uncertain=false){super(message);this.code=code;this.uncertain=uncertain;} }
class DemoAPI {
  constructor(key, signingKey, fetcher=(url,options)=>fetch(url,options), crypt=crypto){this.key=key;this.signingKey=signingKey;this.fetcher=fetcher;this.crypt=crypt;this.offset=0;this.synced=0;this.blockUntil=0;}
  async call(method,path,params={},signed=true){
    if(!(signed?PRIVATE[method]?.has(path):method==='GET'&&PUBLIC.has(path)))throw new DemoError('Request is not allowed on this demo connector.');
    if(Date.now()<this.blockUntil)throw new DemoError('Binance rate limit cooldown. Entries paused.');
    if(signed&&!this.key)throw new DemoError('Demo credentials are disconnected.');
    if(signed&&Date.now()-this.synced>30000){const t=await this.call('GET','/fapi/v1/time',{},false);if(!Number.isFinite(t.serverTime))throw new DemoError('Invalid Binance server time');this.offset=t.serverTime-Date.now();this.synced=Date.now();}
    const query=new URLSearchParams(params);
    const headers={};
    if(signed){query.set('timestamp',String(Date.now()+this.offset));query.set('recvWindow','5000');const bytes=await this.crypt.subtle.sign('HMAC',this.signingKey,new TextEncoder().encode(query.toString()));query.set('signature',Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join(''));headers['X-MBX-APIKEY']=this.key;}
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
    try{
      const opt={method,headers,signal:ctl.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'};
      let url=DEMO_BASE+path;
      if(method==='POST'){headers['Content-Type']='application/x-www-form-urlencoded';opt.body=query.toString();}else if(query.size)url+='?'+query.toString();
      const r=await this.fetcher(url,opt);
      if(r.status===429||r.status===418)this.blockUntil=Date.now()+Math.max(60000,Number(r.headers?.get('Retry-After')||60)*1000);
      let data;try{data=await r.json();}catch{throw new DemoError('Unreadable Binance response; reconcile order status.',0,method!=='GET');}
      if(!r.ok||Number(data.code)<0){const c=Number(data.code)||r.status;const messages={[-2015]:'Demo API permission or IP restriction rejected. Enable Futures trading on the demo key.',[-1022]:'Demo signature rejected. Check the HMAC secret.',[-1021]:'Timestamp rejected. Reconnect to synchronize time.',[-2019]:'Insufficient demo margin.',[-4067]:'Open orders prevent changing margin mode.',[-4168]:'Isolated margin requires Single-Asset Mode.'};throw new DemoError(messages[c]||'Binance Demo rejected request ('+c+').',c,r.status>=500||[-1006,-1007,-4116].includes(c));}
      return data;
    }catch(e){
      const label=method+' '+path;
      if(e instanceof DemoError){e.message=label+': '+e.message;throw e;}
      throw new DemoError(label+': '+(e.name==='AbortError'?'Request timed out.':'The browser could not reach this Binance Demo endpoint (network or CORS block).')+(method==='GET'?' This read request did not submit an order.':' Order status must be reconciled before retrying.'),0,method!=='GET');
    }finally{clearTimeout(timer);}
  }
  clear(){this.key='';this.signingKey=null;}
}
function number(value){if(value===null||value===undefined||value==='')throw new DemoError('Missing Binance numeric value');const n=Number(value);if(!Number.isFinite(n))throw new DemoError('Invalid Binance numeric value');return n;}
function rounded(value,step,up=false){const n=number(step);if(n<=0||value<=0)throw new DemoError('Invalid quantity or tick size');const decimals=Math.min(12,(String(step).split('.')[1]||'').replace(/0+$/,'').length);return ((up?Math.ceil(value/n-1e-9):Math.floor(value/n+1e-9))*n).toFixed(decimals);}
function breakout(raw,now){
  if(!Array.isArray(raw))throw new DemoError('Invalid candle response');
  const bars=raw.filter(x=>number(x[6])<now).map(x=>({t:number(x[0]),end:number(x[6]),h:number(x[2]),l:number(x[3]),c:number(x[4]),v:number(x[5])}));
  if(bars.length<21)return null;
  for(let i=0;i<bars.length;i++){const b=bars[i];if(b.l<=0||b.h<b.l||b.c<b.l||b.c>b.h||b.v<0||b.end-b.t!==299999||(i&&b.t-bars[i-1].t!==300000))throw new DemoError('Invalid or missing candles');}
  const latest=bars.at(-1);if(now-latest.end>315000)return null;
  const prev=bars.slice(-21,-1),high=Math.max(...prev.map(x=>x.h)),low=Math.min(...prev.map(x=>x.l));
  const side=latest.c>high?'BUY':latest.c<low?'SELL':null;
  const atr=bars.slice(-20).reduce((s,b,i)=>{const last=bars[bars.length-21+i];return s+Math.max(b.h-b.l,Math.abs(b.h-last.c),Math.abs(b.l-last.c));},0)/20;
  return side&&atr>0?{side,close:latest.end,price:latest.c,high,low,atr}:null;
}
function exitPrice(entry,qty,fee,target,side,tick){
  // Net = signed price movement minus entry and expected exit taker fees.
  const sign=side==='BUY'?1:-1;
  const price=(target/qty+entry*(sign+fee))/(sign-fee);
  return rounded(price,tick,side==='BUY');
}
function combinedValue(assets,indices,now){
  const rates=new Map((Array.isArray(indices)?indices:[]).map(x=>[x.symbol,x]));let usd=0;
  for(const a of assets){const balance=number(a.marginBalance);if(!balance)continue;const r=rates.get(a.asset+'USD');if(!r||!Number.isFinite(+r.index)||+r.index<=0||!Number.isFinite(+r.time)||Math.abs(now-+r.time)>60000)return null;usd+=balance*+r.index;}
  const usdt=rates.get('USDTUSD');return usdt&&+usdt.index>0?usd/+usdt.index:null;
}
class DemoEngine {
  constructor(api,state,persist,notify=()=>{}){
    this.api=api;this.state=state||{version:1,records:[],startedAt:0,goal:false};this.persist=persist;this.notify=notify;this.auto=false;this.connected=false;this.busy=false;this.stopEpoch=0;this.account=null;this.positions=[];this.orders=[];this.algos=[];this.symbols=[];this.meta=new Map();this.cursor=0;this.scanned=[];this.lastScan=0;this.lastIncome=0;this.income=[];this.events=[];this.block='';this.balance=null;
    if(this.state.version!==1||!Array.isArray(this.state.records))throw new DemoError('Invalid demo journal. Do not start; inspect Binance Demo positions.');
    for(const r of this.state.records)if(!/^[A-Z0-9]+USDT$/.test(r.symbol)||!/^bd1_[a-zA-Z0-9_-]+$/.test(r.id)||!['BUY','SELL'].includes(r.side))throw new DemoError('Invalid saved demo order record.');
  }
  save(){this.persist(this.state);}
  event(text){this.events.unshift({at:Date.now(),text});this.events=this.events.slice(0,60);this.notify();}
  pause(reason){this.auto=false;this.stopEpoch++;if(reason)this.event(reason);}
  active(){return this.state.records.filter(r=>!r.closedAt&&!r.rejected);}
  owned(symbol){return this.active().find(r=>r.symbol===symbol);}
  position(symbol){return this.positions.find(p=>p.symbol===symbol&&number(p.positionAmt)!==0);}
  async initialize(){
    this.pause();
    // The previously working account read must not depend on trading-only routes.
    await this.refreshBalance();this.connected=true;this.notify();
    try{await this.prepareTrading();await this.reconcile();await this.updateIncome();this.event('Demo connected. Auto entries are stopped until Start Demo Auto.');}
    catch(e){this.block='Balance connected; trading check failed. '+e.message;this.pause(this.block);}
  }
  async refreshBalance(){
    const account=await this.api.call('GET','/fapi/v3/account');
    if(!Array.isArray(account.assets)||!Array.isArray(account.positions))throw new DemoError('Invalid Binance account response');
    this.account=account;this.accountAt=Date.now();
    if(!this.tradingReady)this.positions=account.positions.map(p=>({...p,markPrice:p.markPrice??'—',entryPrice:p.entryPrice??'—',unRealizedProfit:p.unrealizedProfit??p.unRealizedProfit??'0'}));
    try{const indices=await this.api.call('GET','/fapi/v1/assetIndex',{},false);this.balance=combinedValue(account.assets,indices,Date.now()+this.api.offset);}catch{this.balance=null;}
    this.notify();
  }
  async prepareTrading(){
    this.tradingReady=false;
    const mode=await this.api.call('GET','/fapi/v1/positionSide/dual');const multi=await this.api.call('GET','/fapi/v1/multiAssetsMargin');
    if(mode.dualSidePosition!==false)throw new DemoError('Set Binance Demo Futures to One-way Mode before starting. No account mode was changed.');
    if(multi.multiAssetsMargin!==false)throw new DemoError('Set Binance Demo Futures to Single-Asset Mode for isolated trades. No account mode was changed.');
    const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);
    if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');
    this.orderUniverse=info.symbols.filter(m=>typeof m.symbol==='string'&&/^[A-Z0-9_]+$/.test(m.symbol)).map(m=>m.symbol);
    for(const m of info.symbols)if(m.status==='TRADING'&&m.contractType==='PERPETUAL'&&m.quoteAsset==='USDT'&&m.marginAsset==='USDT'&&m.underlyingType==='COIN'&&/^[A-Z0-9]+USDT$/.test(m.symbol)&&!['USDC','USDT','BUSD','FDUSD','TUSD','DAI','USDP','USDD','USD1','USDE'].includes(m.baseAsset))this.meta.set(m.symbol,m);
    this.symbols=[...this.meta.keys()].sort();if(!this.symbols.length)throw new DemoError('No eligible crypto futures found');
    this.metaAt=Date.now();await this.refresh();this.tradingReady=true;
  }
  async refresh(){
    const account=await this.api.call('GET','/fapi/v3/account');
    const positions=await this.api.call('GET','/fapi/v3/positionRisk');
    const orders=await this.readOrderInventory('/fapi/v1/openOrders');
    const algos=await this.readOrderInventory('/fapi/v1/openAlgoOrders');
    if(!Array.isArray(account.assets)||!Array.isArray(positions)||!Array.isArray(orders)||!Array.isArray(algos))throw new DemoError('Invalid Binance account or order response');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected. Auto entries stopped.');}
    this.account=account;this.positions=positions;this.orders=orders;this.algos=algos;this.accountAt=Date.now();
    try{const indices=await this.api.call('GET','/fapi/v1/assetIndex',{},false);this.balance=combinedValue(account.assets,indices,Date.now()+this.api.offset);}catch{this.balance=null;}
    this.notify();
  }
  async readOrderInventory(path){
    this.inventoryModes??={};this.inventoryCache??={};
    if(!this.inventoryModes[path]){
      try{const all=await this.api.call('GET',path);if(!Array.isArray(all))throw new DemoError('Invalid order inventory');return all;}
      catch(e){if(e.code!==0||e.uncertain||!this.orderUniverse?.length)throw e;this.inventoryModes[path]='per-symbol';this.event('All-market order read failed. Checking each contract individually; this can take a few minutes.');}
    }
    const cached=this.inventoryCache[path];
    if(cached&&Date.now()-cached.at<60000){
      // Refresh owned contracts even between complete account-wide scans.
      const symbols=new Set(this.active().map(r=>r.symbol));const rows=cached.rows.filter(x=>!symbols.has(x.symbol));
      for(const symbol of symbols){const a=await this.api.call('GET',path,{symbol});if(!Array.isArray(a))throw new DemoError('Invalid symbol order inventory');rows.push(...a);}
      return rows;
    }
    const rows=[];const epoch=this.stopEpoch;
    for(let i=0;i<this.orderUniverse.length;i+=2){
      if(epoch!==this.stopEpoch)throw new DemoError('Order check cancelled by Stop.');
      const batch=this.orderUniverse.slice(i,i+2);
      const results=await Promise.all(batch.map(symbol=>this.api.call('GET',path,{symbol})));
      for(const a of results){if(!Array.isArray(a))throw new DemoError('Incomplete symbol order inventory');rows.push(...a);}
      if(i%40===0)this.event('Checking orders: '+Math.min(i+2,this.orderUniverse.length)+' / '+this.orderUniverse.length+' contracts');
      if(i+2<this.orderUniverse.length)await new Promise(resolve=>setTimeout(resolve,250));
    }
    this.inventoryCache[path]={rows,at:Date.now()};return rows;
  }
  async updateIncome(){
    if(!this.state.startedAt){this.income=[];return;}
    // Pagination and fixed end time avoid silently dropping trades in busy accounts.
    const out=[],endTime=Date.now()+this.api.offset;
    if(endTime-this.state.startedAt>7*86400000)throw new DemoError('Session exceeds 7 days. Review results and start a new session when flat.');
    for(let page=1;page<=20;page++){
      const rows=await this.api.call('GET','/fapi/v1/income',{startTime:this.state.startedAt,endTime,page,limit:1000});
      if(!Array.isArray(rows))throw new DemoError('Invalid income response');out.push(...rows);
      if(rows.length<1000){this.income=out.filter(x=>x.asset==='USDT'&&['REALIZED_PNL','COMMISSION','FUNDING_FEE'].includes(x.incomeType));for(const x of this.income)number(x.income);this.lastIncome=Date.now();return;}
    }
    throw new DemoError('Income history is incomplete. Entries paused.');
  }
  sessionNet(){return this.income.reduce((s,x)=>s+number(x.income),0)+this.positions.filter(p=>p.symbol.endsWith('USDT')).reduce((s,p)=>s+number(p.unRealizedProfit),0);}
  async start(){
    if(!this.connected)throw new DemoError('Connect demo credentials first');
    await this.prepareTrading();
    await this.refresh();await this.reconcile();
    if(this.active().some(r=>r.pendingClose||!r.protected))throw new DemoError('Resolve pending or unprotected orders before starting.');
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol))||this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))throw new DemoError('Unmanaged positions or orders exist in this demo account. Close/cancel them in Binance before starting this bot.');
    if(this.state.goal)throw new DemoError('Session $100 goal reached. Use Earn $100 again when flat.');
    if(!this.state.startedAt){this.state.startedAt=Date.now()+this.api.offset;this.save();}
    await this.updateIncome();if(this.sessionNet()>=100){this.state.goal=true;this.save();throw new DemoError('Session goal already reached');}
    this.auto=true;this.block='';this.event('Auto enabled · 15× isolated · up to $500 margin per entry · $5,000 total margin cap');
  }
  async again(){if(this.active().length||this.positions.some(p=>number(p.positionAmt)!==0)||this.orders.length||this.algos.length)throw new DemoError('Close positions and clear pending orders before another session');this.state.startedAt=Date.now()+this.api.offset;this.state.goal=false;this.save();await this.start();}
  async queryEntry(r){return this.api.call('GET','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.id});}
  async queryExit(e){return this.api.call('GET','/fapi/v1/algoOrder',{clientAlgoId:e.id});}
  async sendOnce(path,params,query){
    try{return await this.api.call('POST',path,params);}catch(e){
      // A transport error or timeout does NOT mean the order failed.
      try{return await query();}catch(q){if(!e.uncertain&&[-2013,-2011].includes(q.code))throw e;throw new DemoError('Order result unknown. Entries paused; reconciling the saved client ID.',0,true);}
    }
  }
  async enter(symbol,signal){
    const epoch=this.stopEpoch;
    if(!this.auto||this.state.goal||this.owned(symbol))return;
    if(this.state.records.some(r=>r.symbol===symbol&&(r.signalClose===signal.close||Date.now()-(r.closedAt||r.at)<300000)))return;
    await this.refresh();
    if(!this.auto||epoch!==this.stopEpoch||this.position(symbol)||this.orders.some(o=>o.symbol===symbol)||this.algos.some(o=>o.symbol===symbol))return;
    // Candidate-specific reads prevent stale cached inventories admitting duplicates.
    for(const path of ['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders']){const existing=await this.api.call('GET',path,{symbol});if(!Array.isArray(existing))throw new DemoError('Order check incomplete');if(existing.length)return;}
    if(Date.now()-this.metaAt>900000)throw new DemoError('Exchange filters expired. Reconnect to refresh.');
    const m=this.meta.get(symbol),lot=m.filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=m.filters.find(f=>f.filterType==='LOT_SIZE'),priceFilter=m.filters.find(f=>f.filterType==='PRICE_FILTER');
    if(!lot||!normal||!priceFilter||!m.orderTypes.includes('MARKET'))return;
    const mark=await this.api.call('GET','/fapi/v1/premiumIndex',{symbol},false);const price=number(mark.markPrice);
    if(Math.abs(Date.now()+this.api.offset-number(mark.time))>15000||Date.now()+this.api.offset-signal.close>315000)return;
    if(Math.abs(price-signal.price)>.5*signal.atr||(signal.side==='BUY'?price<=signal.high:price>=signal.low))return;
    const feeInfo=await this.api.call('GET','/fapi/v1/commissionRate',{symbol}),fee=number(feeInfo.takerCommissionRate);
    if(fee<0||fee>.01)throw new DemoError('Unsupported commission rate');
    const usdt=this.account.assets.find(a=>a.asset==='USDT');if(!usdt)throw new DemoError('No USDT available for isolated trades');
    const reserved=this.positions.reduce((s,p)=>s+Math.abs(number(p.positionInitialMargin||0)),0);
    const budget=Math.min(500,5000-reserved,number(usdt.availableBalance)/(1+30*fee));
    if(budget<=0){this.block='Waiting for available USDT margin';return;}
    const step=number(lot.stepSize)>0?lot.stepSize:normal.stepSize;
    const quantity=rounded(Math.min(budget*15/price,number(lot.maxQty),number(normal.maxQty)),step),qty=number(quantity),notional=qty*price;
    const minNotional=number(m.filters.find(f=>f.filterType==='MIN_NOTIONAL')?.notional||m.filters.find(f=>f.filterType==='NOTIONAL')?.minNotional||0);
    if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional||notional*fee*2>=35){this.block=symbol+': quantity/cost filter';return;}
    try{await this.api.call('POST','/fapi/v1/marginType',{symbol,marginType:'ISOLATED'});}catch(e){if(e.code!==-4046)throw e;}
    const leverage=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:15});
    if(number(leverage.leverage)!==15||number(leverage.maxNotionalValue)<notional)throw new DemoError('15× leverage or position size not accepted');
    if(!this.auto||epoch!==this.stopEpoch||this.shouldScan?.()===false)return;
    const id='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
    const r={id,symbol,side:signal.side,quantity,fee,tick:priceFilter.tickSize,at:Date.now()+this.api.offset,signalClose:signal.close,signal,exits:[],protected:false};
    this.state.records.push(r);this.save(); // Journal before dispatch; never duplicate an uncertain entry.
    try{const order=await this.sendOnce('/fapi/v1/order',{symbol,side:r.side,positionSide:'BOTH',type:'MARKET',quantity,newClientOrderId:id,newOrderRespType:'RESULT'},()=>this.queryEntry(r));r.orderId=order.orderId;r.entryStatus=order.status;this.save();
      // Install protection directly from a confirmed fill before slower balance reads.
      if(order.status==='FILLED'&&Number(order.avgPrice)>0&&Number(order.executedQty)>0){
        const filled={entryPrice:order.avgPrice,positionAmt:r.side==='BUY'?order.executedQty:String(-Number(order.executedQty)),markPrice:order.avgPrice};r.entry=Number(order.avgPrice);r.filledQty=Number(order.executedQty);this.save();
        try{await this.ensureExit(r,filled,'sl',-35);if(!r.closedAt)await this.ensureExit(r,filled,'tp',40);r.protected=!r.closedAt;this.save();}
        catch(e){this.pause('Protection failed immediately after fill.');await this.close(symbol,'Protection failure');throw e;}
      }
    }
    catch(e){if(!e.uncertain&&!r.entryStatus){r.rejected=true;this.save();}this.pause(e.message);throw e;}
    await this.refresh();await this.reconcile();this.event(symbol+' demo entry submitted; confirmed fills and protection shown below.');
  }
  async cancelExits(r){
    for(const e of r.exits||[]){if(e.cancelled)continue;try{await this.api.call('DELETE','/fapi/v1/algoOrder',{clientAlgoId:e.id});e.cancelled=true;this.save();}catch(err){const found=await this.queryExit(e).catch(q=>{if([-2011,-2013].includes(q.code))return {algoStatus:'NOT_FOUND'};throw q;});if(['CANCELED','CANCELLED','FINISHED','EXPIRED','REJECTED','NOT_FOUND'].includes(found.algoStatus)){e.cancelled=true;this.save();}else throw err;}}
  }
  async ensureExit(r,p,kind,target){
    let e=r.exits.find(e=>e.kind===kind&&!e.cancelled);
    if(e){const q=await this.queryExit(e);if(q.algoStatus==='NEW'){e.confirmed=true;return;}throw new DemoError(r.symbol+' protective '+kind+' is '+q.algoStatus+'; checking position.');}
    const triggerPrice=exitPrice(number(p.entryPrice),Math.abs(number(p.positionAmt)),r.fee,target,r.side,r.tick);
    const mark=number(p.markPrice);if((kind==='tp')?(r.side==='BUY'?mark>=+triggerPrice:mark<=+triggerPrice):(r.side==='BUY'?mark<=+triggerPrice:mark>=+triggerPrice)){await this.close(r.symbol,kind+' threshold reached');return;}
    e={id:r.id+'_'+kind,kind,triggerPrice,confirmed:false};r.exits.push(e);this.save();
    const result=await this.sendOnce('/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:r.symbol,side:r.side==='BUY'?'SELL':'BUY',positionSide:'BOTH',type:kind==='tp'?'TAKE_PROFIT_MARKET':'STOP_MARKET',closePosition:'true',triggerPrice,workingType:'MARK_PRICE',priceProtect:'false',clientAlgoId:e.id},()=>this.queryExit(e));
    if(result.algoStatus!=='NEW')throw new DemoError('Protection was not confirmed NEW');
    e.confirmed=true;this.save();
  }
  async close(symbol,reason='Manual close'){
    const r=this.owned(symbol);if(!r)throw new DemoError('This position is not owned by this bot. Manage it in Binance Demo.');
    if(r.pendingClose){const order=await this.api.call('GET','/fapi/v1/order',{symbol,origClientOrderId:r.pendingClose});if(!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(order.status))throw new DemoError('Close order still pending');r.pendingClose=null;this.save();await this.refresh();}
    const list=await this.api.call('GET','/fapi/v3/positionRisk',{symbol});if(!Array.isArray(list))throw new DemoError('Invalid position response');
    const p=list.find(x=>x.symbol===symbol&&x.positionSide==='BOTH'&&number(x.positionAmt)!==0);
    if(!p){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();return;}
    if((number(p.positionAmt)>0)!==(r.side==='BUY'))throw new DemoError('Position direction changed outside bot. Inspect Binance.');
    r.pendingClose='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,22)+'_c';r.closeReason=reason;this.save();
    const order=await this.sendOnce('/fapi/v1/order',{symbol,side:number(p.positionAmt)>0?'SELL':'BUY',positionSide:'BOTH',type:'MARKET',quantity:String(Math.abs(number(p.positionAmt))),reduceOnly:'true',newClientOrderId:r.pendingClose,newOrderRespType:'RESULT'},()=>this.api.call('GET','/fapi/v1/order',{symbol,origClientOrderId:r.pendingClose}));
    if(order.status==='FILLED'){r.pendingClose=null;this.save();}else throw new DemoError('Close order awaiting final status');
    await this.refresh();if(!this.position(symbol)){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();this.event(symbol+' closed · '+reason);}
  }
  async reconcile(){
    for(const r of this.active()){
      let order;
      try{order=await this.queryEntry(r);}catch(e){
        // A fresh position can prove that an ambiguous entry filled even when
        // the order query is temporarily unavailable. Protect it immediately.
        if(!this.position(r.symbol))throw e;
        this.pause('Entry status unavailable; protecting observed position.');
        order={status:'UNKNOWN',orderId:r.orderId};
      }
      r.orderId=order.orderId;r.entryStatus=order.status;
      if(['NEW','PARTIALLY_FILLED'].includes(order.status)){this.pause('Entry not fully settled; cancelling remainder.');await this.api.call('DELETE','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.id});await this.refresh();}
      const p=this.position(r.symbol);
      if(!p){if(r.observedOpen||(['CANCELED','EXPIRED','REJECTED'].includes(order.status)&&Number(order.executedQty)===0)){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();continue;}throw new DemoError('Filled entry awaiting position confirmation; no new orders');}
      if((number(p.positionAmt)>0)!==(r.side==='BUY'))throw new DemoError('Position direction changed outside bot');
      r.observedOpen=true;r.entry=number(p.entryPrice);r.filledQty=Math.abs(number(p.positionAmt));
      if(r.pendingClose){await this.close(r.symbol,r.closeReason);continue;}
      try{
        await this.ensureExit(r,p,'sl',-35);if(r.closedAt||r.pendingClose)continue;
        await this.ensureExit(r,p,'tp',40);if(r.closedAt||r.pendingClose)continue;
        r.protected=true;
        const net=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.netEstimate=net;r.peak=Math.max(r.peak??-Infinity,net);
        if(net<=-35||net>=40||(r.peak>10&&net<=10)){await this.close(r.symbol,net<=-35?'$35 loss threshold':net>=40?'$40 profit threshold':'$10 profit floor');continue;}
        if(r.peak>10)await this.ensureExit(r,p,'floor',10);
        this.save();
      }catch(e){
        this.pause('Protection problem on '+r.symbol+'. Attempting reduce-only close.');
        // Never continue opening positions after a failed protective order.
        try{await this.close(r.symbol,'Protection failure');}catch(closeError){throw new DemoError('URGENT: '+r.symbol+' requires review in Binance Demo. '+closeError.message);}
        throw e;
      }
    }
  }
  async scan(){
    if(!this.auto||this.shouldScan?.()===false)return;
    const epoch=this.stopEpoch;this.lastScan=Date.now();
    for(let i=0;i<12&&this.auto&&epoch===this.stopEpoch&&this.shouldScan?.()!==false;i++){
      const symbol=this.symbols[this.cursor++%this.symbols.length];if(this.owned(symbol))continue;
      const raw=await this.api.call('GET','/fapi/v1/klines',{symbol,interval:'5m',limit:60},false);
      const signal=breakout(raw,Date.now()+this.api.offset);this.scanned.unshift({symbol,side:signal?.side||'WAIT',at:Date.now()});this.scanned=this.scanned.slice(0,30);this.notify();
      if(signal&&this.auto&&epoch===this.stopEpoch){await this.updateIncome();if(this.sessionNet()>=100){this.state.goal=true;this.pause('Session goal reached');this.save();return;}await this.enter(symbol,signal);}
    }
  }
  async tick(){
    if(!this.connected||this.busy)return;this.busy=true;
    try{
      if(!this.tradingReady){await this.refreshBalance();return;}
      await this.refresh();await this.reconcile();if(Date.now()-this.lastIncome>15000)await this.updateIncome();
      if(this.auto&&Date.now()-this.metaAt>600000){const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');for(const symbol of [...this.meta.keys()]){const m=info.symbols.find(x=>x.symbol===symbol&&x.status==='TRADING');if(m)this.meta.set(symbol,m);else this.meta.delete(symbol);}this.symbols=[...this.meta.keys()].sort();this.metaAt=Date.now();}
      if(this.state.startedAt&&this.sessionNet()>=100){this.state.goal=true;this.pause('Session $100 goal reached; closing bot positions.');this.save();}
      if(this.state.goal)for(const r of this.active())await this.close(r.symbol,'$100 session goal');
      if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))this.pause('Unmanaged position detected; auto entries stopped.');
      if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))this.pause('Unmanaged orders detected; auto entries stopped.');
      if(this.auto&&Date.now()-this.lastScan>30000)await this.scan();
      this.block='';
    }catch(e){this.block=e.message;this.pause(e.message);}finally{this.busy=false;this.notify();}
  }
}
if(typeof module!=='undefined')module.exports={DemoAPI,DemoEngine,DemoError,rounded,breakout,exitPrice,combinedValue,DEMO_BASE};
