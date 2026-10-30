'use strict';
const LEVERAGE_OVERRIDE_UNTIL=1793406469000; // 31 Oct 2026, 04:27:49 Asia/Dubai
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
    if(signed&&this.relayToken){
      const previous=this.requestQueue||Promise.resolve();let release;
      this.requestQueue=new Promise(resolve=>{release=resolve;});
      await previous;
      try{const delay=Math.max(0,(this.nextRequestAt||0)-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));this.nextRequestAt=Date.now()+500;}
      finally{release();}
    }
    if(Date.now()<this.blockUntil)throw new DemoError((this.limitSource||'API')+' cooldown: '+Math.ceil((this.blockUntil-Date.now())/1000)+' seconds remaining. New entries paused.',429);
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
      if(signed&&this.relayToken){
        url='http://127.0.0.1:10000/relay';
        opt.method='POST';opt.headers={'Content-Type':'application/json',Authorization:'Bearer '+this.relayToken};
        opt.body=JSON.stringify({method,path,query:query.toString(),apiKey:this.key});
      }
      const r=await this.fetcher(url,opt);
      if(r.status===429||r.status===418)this.blockUntil=Date.now()+Math.max(60000,Number(r.headers?.get('Retry-After')||60)*1000);
      let data;try{data=await r.json();}catch{throw new DemoError('Unreadable Binance response; reconcile order status.',0,method!=='GET');}
      if(r.status===429||r.status===418){
        this.limitSource=data.error==='Backend rate limit; no request forwarded'?'Local backend':data.error==='Binance cooldown; no request forwarded'||Number(data.code)<0?'Binance':this.relayToken?'Backend or Binance':'Binance';
        throw new DemoError(this.limitSource+' rate limit (HTTP '+r.status+'). Wait '+Math.ceil((this.blockUntil-Date.now())/1000)+' seconds before Retry connection or Start / Resume. No automatic order retry.',r.status,method!=='GET');
      }
      if(signed&&this.relayToken&&data.error==='Backend access token rejected')throw new DemoError('Local connection token rejected. Unlock saved keys and replace the token with the one from the running Windows backend.',401);
      if(!r.ok||Number(data.code)<0){const c=Number(data.code)||r.status;const messages={[-2027]:'Position size exceeds Binance limit at the selected leverage.',[-2015]:'Demo API permission or IP restriction rejected. Enable Futures trading on the demo key.',[-1022]:'Demo signature rejected. Check the HMAC secret.',[-1021]:'Timestamp rejected. Reconnect to synchronize time.',[-2019]:'Insufficient demo margin.',[-4067]:'Open orders prevent changing margin mode.',[-4168]:'Isolated margin requires Single-Asset Mode.'};throw new DemoError(messages[c]||'Binance Demo rejected request ('+c+').',c,r.status>=500||[-1006,-1007,-4116].includes(c));}
      return data;
    }catch(e){
      const label=method+' '+path;
      if(e instanceof DemoError){e.message=label+': '+e.message;throw e;}
      throw new DemoError(label+': '+(e.name==='AbortError'?'Request timed out.':'The browser could not reach this Binance Demo endpoint (network or CORS block).')+(method==='GET'?' This read request did not submit an order.':' Order status must be reconciled before retrying.'),0,method!=='GET');
    }finally{clearTimeout(timer);}
  }
  clear(){this.key='';this.signingKey=null;this.relayToken='';}
}
function number(value){if(value===null||value===undefined||value==='')throw new DemoError('Missing Binance numeric value');const n=Number(value);if(!Number.isFinite(n))throw new DemoError('Invalid Binance numeric value');return n;}
function rounded(value,step,up=false){const n=number(step);if(n<=0||value<=0)throw new DemoError('Invalid quantity or tick size');const decimals=Math.min(12,(String(step).split('.')[1]||'').replace(/0+$/,'').length);return ((up?Math.ceil(value/n-1e-9):Math.floor(value/n+1e-9))*n).toFixed(decimals);}
function breakout(raw,now,intervalMs=300000){
  if(!Array.isArray(raw))throw new DemoError('Invalid candle response');
  const bars=raw.filter(x=>number(x[6])<now).map(x=>({t:number(x[0]),end:number(x[6]),h:number(x[2]),l:number(x[3]),c:number(x[4]),v:number(x[5])}));
  if(bars.length<21)return null;
  for(let i=0;i<bars.length;i++){const b=bars[i];if(b.l<=0||b.h<b.l||b.c<b.l||b.c>b.h||b.v<0||b.end-b.t!==intervalMs-1||(i&&b.t-bars[i-1].t!==intervalMs))throw new DemoError('Invalid or missing candles');}
  const latest=bars.at(-1);if(now-latest.end>intervalMs+15000)return null;
  const prev=bars.slice(-21,-1),high=Math.max(...prev.map(x=>x.h)),low=Math.min(...prev.map(x=>x.l));
  const side=latest.c>high?'BUY':latest.c<low?'SELL':null;
  const atr=bars.slice(-20).reduce((s,b,i)=>{const last=bars[bars.length-21+i];return s+Math.max(b.h-b.l,Math.abs(b.h-last.c),Math.abs(b.l-last.c));},0)/20;
  return side&&atr>0?{side,close:latest.end,price:latest.c,high,low,atr}:null;
}
function twoMinuteBars(raw,now){
  // Build only complete UTC-aligned pairs of closed one-minute candles.
  breakout(raw,now,60000);
  const closed=raw.filter(b=>number(b[6])<now),result=[];
  for(let i=0;i<closed.length;i++){const b=closed[i];if(number(b[6])-number(b[0])!==59999||(i&&number(b[0])-number(closed[i-1][0])!==60000))throw new DemoError('Invalid or missing candles');}
  for(let i=0;i<closed.length-1;i++){
    const a=closed[i],b=closed[i+1],t=number(a[0]);
    if(t%120000!==0||number(b[0])!==t+60000)continue;
    result.push([t,a[1],Math.max(number(a[2]),number(b[2])),Math.min(number(a[3]),number(b[3])),b[4],number(a[5])+number(b[5]),b[6]]);
    i++;
  }
  return result;
}
// Experimental entry filters: score describes rule agreement, not win probability.
function qualifySetup(signal,raw,hourly,now,explain=()=>{},trendMs=3600000){
  const reject=reason=>{explain(reason);return null;};
  if(!signal)return null;
  const bars=raw.filter(b=>number(b[6])<now),hours=hourly.filter(b=>number(b[6])<now);
  if(bars.length<21||hours.length<50)return reject('Not enough candle history');
  for(let i=0;i<hours.length;i++){
    const b=hours[i];if(number(b[4])<=0||number(b[6])-number(b[0])!==trendMs-1||(i&&number(b[0])-number(hours[i-1][0])!==trendMs))return null;
  }
  if(now-number(hours.at(-1)[6])>trendMs+15000)return reject('Confirmation candles are stale');
  const mean=a=>a.reduce((v,b)=>v+number(b[4]),0)/a.length;
  const fast=mean(hours.slice(-20)),slow=mean(hours.slice(-50)),prior=mean(hours.slice(-21,-1)),last=number(hours.at(-1)[4]);
  const buy=signal.side==='BUY';
  if(!(buy?last>fast&&fast>slow&&fast>prior:last<fast&&fast<slow&&fast<prior))return reject('Confirmation trend does not confirm breakout');
  const b=bars.at(-1),range=number(b[2])-number(b[3]);if(range<=0)return null;
  const volumeMean=bars.slice(-21,-1).reduce((v,b)=>v+number(b[5]),0)/20;
  if(volumeMean<=0)return null;
  const volumeRatio=number(b[5])/volumeMean,closeStrength=buy?(number(b[4])-number(b[3]))/range:(number(b[2])-number(b[4]))/range;
  const body=Math.abs(number(b[4])-number(b[1]))/range;
  if(volumeRatio<1.2)return reject('Volume below 1.2× average');
  if(closeStrength<.65||body<.4)return reject('Breakout candle lacks confirmation');
  if(range>2*signal.atr)return reject('Breakout candle exceeds volatility limit');
  const moderate=volumeRatio<1.5||closeStrength<.75||body<.5;
  const score=moderate?1:1+Number(volumeRatio>=2)+Number(closeStrength>=.9&&body>=.7);
  return {...signal,qualityConfirmed:true,strength:score,leverage:score===3?8:score===2?5:3,stopDistance:1.5*signal.atr,volumeRatio};
}
function experimentSignal(raw,now){
  breakout(raw,now,60000);
  const bars=raw.filter(b=>number(b[6])<now);
  if(bars.length<21)return null;
  const b=bars.at(-1),open=number(b[1]),price=number(b[4]);
  if(now-number(b[6])>75000||open<=0||open===price)return null;
  const atr=bars.slice(-20).reduce((v,b)=>v+number(b[2])-number(b[3]),0)/20;
  if(atr<=0)return null;
  return {side:price>open?'BUY':'SELL',price,close:number(b[6]),high:number(b[2]),low:number(b[3]),atr,stopDistance:1.5*atr,qualityConfirmed:true,experimental:true,leverage:3,intervalMs:60000,exitPolicy:'manual-profit-60s-loss'};
}
function profitFloor(peak){if(!Number.isFinite(peak)||peak<1)return null;let floor=.5;while(peak>=floor*4)floor*=2;return floor;}
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
    this.experimentUntil=LEVERAGE_OVERRIDE_UNTIL;this.overrideUntil=LEVERAGE_OVERRIDE_UNTIL;this.api=api;this.state=state||{version:1,records:[],startedAt:0,goal:false};this.persist=persist;this.notify=notify;this.auto=false;this.connected=false;this.busy=false;this.stopEpoch=0;this.account=null;this.positions=[];this.orders=[];this.algos=[];this.symbols=[];this.meta=new Map();this.cursor=0;this.scanned=[];this.lastScan=0;this.lastIncome=0;this.income=[];this.events=[];this.block='';this.balance=null;
    if(this.state.version!==1||!Array.isArray(this.state.records))throw new DemoError('Invalid demo journal. Do not start; inspect Binance Demo positions.');
    for(const r of this.state.records)if(!/^[A-Z0-9]+USDT$/.test(r.symbol)||!/^bd1_[a-zA-Z0-9_-]+$/.test(r.id)||!['BUY','SELL'].includes(r.side))throw new DemoError('Invalid saved demo order record.');
  }
  experimentActive(){return Date.now()+this.api.offset<this.experimentUntil;}
  exitsSuspended(r){return Number.isFinite(r.experimentUntil)&&Date.now()+this.api.offset<r.experimentUntil;}
  entryLeverage(signal,now=Date.now()+this.api.offset){return now<this.overrideUntil?50:signal.leverage;}
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
    if(multi.multiAssetsMargin!==false)throw new DemoError('Set Binance Demo Futures to Single-Asset Mode for USDT cross-margin trades. No account mode was changed.');
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
    if(!Array.isArray(account.assets)||!Array.isArray(positions))throw new DemoError('Invalid Binance position snapshot');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);}
    // Publish exchange positions before potentially slow order inventory reads.
    this.account=account;this.positions=positions;this.positionAt=Date.now();this.accountAt=this.positionAt;this.notify();
    const orders=await this.readOrderInventory('/fapi/v1/openOrders');
    const algos=await this.readOrderInventory('/fapi/v1/openAlgoOrders');
    if(!Array.isArray(account.assets)||!Array.isArray(positions)||!Array.isArray(orders)||!Array.isArray(algos))throw new DemoError('Invalid Binance account or order response');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected. Auto entries stopped.');}
    this.account=account;this.positions=positions;this.orders=orders;this.algos=algos;this.ordersAt=Date.now();
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
    if(this.active().some(r=>r.pendingClose||(!r.protected&&!this.exitsSuspended(r))))throw new DemoError('Resolve pending or unprotected orders before starting.');
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol))||this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))throw new DemoError('Unmanaged positions or orders exist in this demo account. Close/cancel them in Binance before starting this bot.');
    if(this.state.goal&&!this.experimentActive())throw new DemoError('Session $100 goal reached. Use Earn $100 again when flat.');
    if(!this.state.startedAt){this.state.startedAt=Date.now()+this.api.offset;this.save();}
    await this.updateIncome();if(!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;this.save();throw new DemoError('Session goal already reached');}
    this.auto=true;this.block='';this.event(this.experimentActive()?'EXPERIMENT enabled · 50× · available USDT · no automatic exits on new positions until '+new Date(this.experimentUntil).toISOString():'Auto enabled · filtered signals · adaptive 3× / 5× / 8× cross · up to $100 margin per entry · $1,000 budget · $800 total margin cap');
  }
  async resetFromBinance(){
    this.pause('Refreshing Binance before reset.');
    // Force a complete fresh inventory, never rely on cached empty orders.
    this.inventoryCache={};
    await this.refresh();
    if(this.positions.some(p=>number(p.positionAmt)!==0)||this.orders.length||this.algos.length)
      throw new DemoError('Reset blocked: close positions and clear pending orders in Binance first.');
    if(!Number.isFinite(this.balance)||this.balance<=0)
      throw new DemoError('Reset blocked: fresh combined asset valuation is unavailable.');
    // A pending entry may have been accepted but not appeared in position reads yet.
    for(const r of this.active()){
      const order=await this.queryEntry(r);
      if(!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(order.status)||r.pendingClose)
        throw new DemoError('Reset blocked: an order is still unresolved.');
      if(!r.observedOpen&&order.status==='FILLED')
        throw new DemoError('Reset blocked: filled entry awaiting reconciliation.');
    }
    const previous=this.state;
    this.state={version:1,records:[],startedAt:0,goal:false,
      budgetWalletBaseline:previous.budgetWalletBaseline,
      resetAt:Date.now()+this.api.offset,resetBalance:this.balance,
      archives:[...(previous.archives||[]),{at:Date.now(),records:previous.records,startedAt:previous.startedAt,goal:previous.goal}]};
    try{this.save();}catch(error){this.state=previous;throw error;}
    this.income=[];this.lastIncome=0;this.scanned=[];this.cursor=0;this.lastScan=0;this.block='';
    this.events=[];this.event('Reset complete from Binance. Session cleared; auto stopped. Credentials kept.');
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
  budgetStatus(){
    const usdt=this.account?.assets.find(a=>a.asset==='USDT');
    if(!usdt)return {equity:0,reserved:0,free:0};
    const wallet=number(usdt.walletBalance),base=this.state.budgetWalletBaseline??wallet;
    const unrealized=number(usdt.unrealizedProfit??0);
    const equity=Math.max(0,Math.min(1000,1000+wallet-base+unrealized,wallet+unrealized));
    const reserved=this.positions.reduce((sum,p)=>sum+Math.abs(number(p.positionInitialMargin||0)),0);
    const free=Math.max(0,Math.min(800,equity-200)-reserved);
    return {equity,reserved,free};
  }
  async enter(symbol,signal){
    const progress=reason=>{this.entryOutcome=reason;const row=this.scanned.find(s=>s.symbol===symbol);if(row){row.reason=reason;this.notify();}};
    const skip=reason=>{progress(reason);return false;};
    this.entryOutcome='Checking entry';
    const epoch=this.stopEpoch;
    if(!this.auto||(this.state.goal&&!this.experimentActive())||this.owned(symbol))return skip('Auto paused, session goal reached, or already owned');
    if(!signal.qualityConfirmed||![3,5,8].includes(signal.leverage)||!Number.isFinite(signal.stopDistance)||signal.stopDistance<=0)return skip('Signal validation failed');
    const experimental=this.experimentActive()&&signal.experimental===true;
    if(signal.experimental&&!experimental)return skip('Experiment expired; waiting for a normal signal');
    const lossLimit=signal.exitPolicy==='manual-profit-60s-loss'?5:9;
    if(this.state.records.some(r=>r.symbol===symbol&&(r.signalClose===signal.close||Date.now()-(r.closedAt||r.at)<60000)))return skip('Already traded this candle or 60s re-entry cooldown');
    progress('Checking Binance balance, positions and open orders');
    await this.refresh();
    if(!this.auto||epoch!==this.stopEpoch||this.position(symbol)||this.orders.some(o=>o.symbol===symbol)||this.algos.some(o=>o.symbol===symbol))return skip('Auto changed or existing position/order');
    // Candidate-specific reads prevent stale cached inventories admitting duplicates.
    progress('Checking this symbol for existing orders');
    for(const path of ['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders']){const existing=await this.api.call('GET',path,{symbol});if(!Array.isArray(existing))throw new DemoError('Order check incomplete');if(existing.length)return skip('Existing Binance order on this symbol');}
    if(Date.now()-this.metaAt>900000)throw new DemoError('Exchange filters expired. Reconnect to refresh.');
    const m=this.meta.get(symbol),lot=m.filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=m.filters.find(f=>f.filterType==='LOT_SIZE'),priceFilter=m.filters.find(f=>f.filterType==='PRICE_FILTER');
    if(!lot||!normal||!priceFilter||!m.orderTypes.includes('MARKET'))return skip('Market-order filters unavailable');
    progress('Checking current entry price');
    const mark=await this.api.call('GET','/fapi/v1/premiumIndex',{symbol},false);const price=number(mark.markPrice);
    if(Math.abs(Date.now()+this.api.offset-number(mark.time))>15000||Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000)return skip('Signal or mark price became stale');
    if(!experimental&&(Math.abs(price-signal.price)>.5*signal.atr||(signal.side==='BUY'?price<=signal.high:price>=signal.low)))return skip('Price moved too far or breakout reversed');
    progress('Checking commission and position size');
    const feeInfo=await this.api.call('GET','/fapi/v1/commissionRate',{symbol}),fee=number(feeInfo.takerCommissionRate);
    if(fee<0||fee>.01)throw new DemoError('Unsupported commission rate');
    const usdt=this.account.assets.find(a=>a.asset==='USDT');if(!usdt)throw new DemoError('No USDT available for USDT cross-margin trades');
    if(this.state.budgetWalletBaseline===undefined){this.state.budgetWalletBaseline=number(usdt.walletBalance);this.save();}
    const capital=this.budgetStatus();
    const selectedLeverage=this.entryLeverage(signal);
    const budget=Math.min(100,(experimental?number(usdt.availableBalance):capital.free)/(1+2*selectedLeverage*fee),number(usdt.availableBalance)/(1+2*selectedLeverage*fee));
    if(budget<=0){this.block='Waiting for room in the $1,000 budget ($200 reserve)';return skip(this.block);}
    const step=number(lot.stepSize)>0?lot.stepSize:normal.stepSize;
    let quantity=rounded(Math.min(budget*selectedLeverage/price,experimental?Infinity:lossLimit/(signal.stopDistance+fee*(2*price+signal.stopDistance)),number(lot.maxQty),number(normal.maxQty)),step),qty=number(quantity),notional=qty*price;
    const minNotional=number(m.filters.find(f=>f.filterType==='MIN_NOTIONAL')?.notional||m.filters.find(f=>f.filterType==='NOTIONAL')?.minNotional||0);
    if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional||(!experimental&&notional*fee*2>=lossLimit)){this.block=symbol+': quantity/cost filter';return skip(this.block);}
    progress('Configuring Cross margin and leverage');
    try{await this.api.call('POST','/fapi/v1/marginType',{symbol,marginType:'CROSSED'});}catch(e){if(e.code!==-4046)throw e;}
    const leverage=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:selectedLeverage});
    if(number(leverage.leverage)!==selectedLeverage)throw new DemoError('Selected leverage not accepted');
    const cap=number(leverage.maxNotionalValue)*.95;
    if(cap<=0)return skip('No position capacity at selected leverage');
    if(notional>cap){
      quantity=rounded(Math.min(qty,cap/price),step);qty=number(quantity);notional=qty*price;
      if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional)return skip('Leverage position cap is below the minimum order size');
      progress('Reduced order size to fit Binance leverage limit');
    }
    if(!this.auto||epoch!==this.stopEpoch||this.shouldScan?.()===false)return skip('Auto stopped before entry dispatch');
    if(experimental&&!this.experimentActive())return skip('Experiment expired before order submission');
    if(this.entryLeverage(signal)!==selectedLeverage)return skip('50× window expired during checks; next scan uses adaptive leverage');
    const id='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
    const r={id,symbol,side:signal.side,quantity,fee,tick:priceFilter.tickSize,at:Date.now()+this.api.offset,signalClose:signal.close,signal,experimentUntil:experimental?this.experimentUntil:null,leverage:selectedLeverage,lossLimit,exitPolicy:signal.exitPolicy,exits:[],protected:false};
    this.state.records.push(r);this.save(); // Journal before dispatch; never duplicate an uncertain entry.
    progress('Submitting demo order');
    try{const order=await this.sendOnce('/fapi/v1/order',{symbol,side:r.side,positionSide:'BOTH',type:'MARKET',quantity,newClientOrderId:id,newOrderRespType:'RESULT'},()=>this.queryEntry(r));r.orderId=order.orderId;r.entryStatus=order.status;this.save();
      // Install protection directly from a confirmed fill before slower balance reads.
      if(order.status==='FILLED'&&Number(order.avgPrice)>0&&Number(order.executedQty)>0){
        const filled={entryPrice:order.avgPrice,positionAmt:r.side==='BUY'?order.executedQty:String(-Number(order.executedQty)),markPrice:order.avgPrice};r.entry=Number(order.avgPrice);r.filledQty=Number(order.executedQty);this.save();
        try{if(!this.exitsSuspended(r)){await this.ensureExit(r,filled,'sl',-(r.lossLimit??9));if(!r.closedAt&&r.exitPolicy!=='manual-profit-60s-loss')await this.ensureExit(r,filled,'tp',40);r.protected=!r.closedAt;}this.save();}
        catch(e){this.pause('Protection failed immediately after fill.');await this.close(symbol,'Protection failure');throw e;}
      }
    }
    catch(e){
      if(!e.uncertain&&!r.entryStatus){
        r.rejected=true;this.save();
        if(e.code===-2027){
          this.event(symbol+' skipped: Binance position-size limit at '+selectedLeverage+'×; scanning continues.');
          return skip('Binance leverage-size limit rejected this entry; continuing other coins');
        }
      }
      this.pause(e.message);throw e;
    }
    await this.refresh();await this.reconcile();this.entryOutcome=r.closedAt?'Entry closed during protection checks':'Entry submitted; status '+r.entryStatus;this.event(symbol+(this.exitsSuspended(r)?' demo entry submitted; automatic exits SUSPENDED until experiment expiry.':' demo entry submitted; confirmed fills and protection shown below.'));
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
      r.openedAt=r.openedAt||Number(order.updateTime)||r.at;r.observedOpen=true;r.entry=number(p.entryPrice);r.filledQty=Math.abs(number(p.positionAmt));
      if(r.pendingClose){await this.close(r.symbol,r.closeReason);continue;}
      if(this.exitsSuspended(r)){r.netEstimate=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.protected=false;this.save();continue;}
      try{
        await this.ensureExit(r,p,'sl',-(r.lossLimit??9));if(r.closedAt||r.pendingClose)continue;
        if(r.exitPolicy!=='manual-profit-60s-loss')await this.ensureExit(r,p,'tp',40);if(r.closedAt||r.pendingClose)continue;
        r.protected=true;
        const net=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.netEstimate=net;r.peak=Math.max(r.peak??-Infinity,net);
        if(r.exitPolicy==='manual-profit-60s-loss'){
          const raised=profitFloor(r.peak);
          if(raised!==null)r.profitFloor=Math.max(r.profitFloor??0,raised);
          this.save();
          if(Number.isFinite(r.profitFloor)&&net<=r.profitFloor){await this.close(r.symbol,'Profit pullback to $'+r.profitFloor.toFixed(2)+' floor');continue;}
          const observedAt=Date.now()+this.api.offset;
          if(net<0){if(!Number.isFinite(r.lossSince))r.lossSince=observedAt;}else r.lossSince=null;
          this.save();
          if(net<=-(r.lossLimit??9)||(net<0&&observedAt-r.lossSince>=60000)){await this.close(r.symbol,net<=-(r.lossLimit??9)?'$'+(r.lossLimit??9)+' loss threshold':'Estimated net loss persisted for 60 seconds');continue;}
          this.save();continue;
        }
        if(net<=-9||net>=40||(r.peak>10&&net<=10)){await this.close(r.symbol,net<=-9?'$9 loss threshold':net>=40?'$40 profit threshold':'$10 profit floor');continue;}
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
    if(!this.auto||!this.symbols.length||this.shouldScan?.()===false)return;
    const epoch=this.stopEpoch;this.lastScan=Date.now();
    this.rechecks=this.rechecks||new Map();
    const due=[...this.rechecks].filter(([symbol,v])=>this.symbols.includes(symbol)&&!this.owned(symbol)&&Date.now()-v.seen<300000&&Date.now()-v.checked>=30000).sort((a,b)=>a[1].checked-b[1].checked).slice(0,4).map(([symbol])=>symbol);
    const batch=[...due];
    for(let i=0;i<Math.min(12,this.symbols.length);i++){const symbol=this.symbols[this.cursor++%this.symbols.length];if(!batch.includes(symbol))batch.push(symbol);}
    for(const [symbol,v] of this.rechecks)if(Date.now()-v.seen>=300000)this.rechecks.delete(symbol);
    for(const symbol of batch){
      if(!this.auto||epoch!==this.stopEpoch||this.shouldScan?.()===false)break;
      if(this.owned(symbol))continue;
      const raw=await this.api.call('GET','/fapi/v1/klines',{symbol,interval:'1m',limit:60},false);
      const now=Date.now()+this.api.offset;
      let bars=raw,intervalMs=60000,candidate=breakout(raw,now,60000);
      if(!candidate){bars=twoMinuteBars(raw,now);intervalMs=120000;candidate=breakout(bars,now,120000);}
      if(candidate)this.rechecks.set(symbol,{seen:Date.now(),checked:Date.now()});else if(this.rechecks.has(symbol))this.rechecks.get(symbol).checked=Date.now();
      let signal=null,reason='No closed 1m or 2m breakout';
      if(this.experimentActive()){signal=experimentSignal(raw,now);reason='Experiment: no fresh directional candle';}
      else if(candidate){const hourly=await this.api.call('GET','/fapi/v1/klines',{symbol,interval:'5m',limit:60},false);reason='Candle history failed validation';signal=qualifySetup(candidate,bars,hourly,Date.now()+this.api.offset,r=>reason=r,300000);if(signal)signal={...signal,exitPolicy:"manual-profit-60s-loss",intervalMs};}
      this.scanChecked=(this.scanChecked||0)+1;
      this.scanned=this.scanned.filter(s=>s.symbol!==symbol);
      this.scanned.unshift({symbol,reason:signal?'Checking session P&L before entry ('+(intervalMs/60000)+'m signal)':reason,side:signal?.side||'WAIT',strength:signal?.strength,leverage:signal?this.entryLeverage(signal):undefined,at:Date.now()});this.scanned=this.scanned.slice(0,30);this.notify();
      if(signal&&this.auto&&epoch===this.stopEpoch){try{await this.updateIncome();if(!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;this.scanned[0].reason='Session goal reached; new entries paused';this.pause('Session goal reached');this.save();return;}await this.enter(symbol,signal);this.scanned[0].reason=this.entryOutcome;}catch(e){this.scanned[0].reason='Entry failed: '+e.message;throw e;}finally{this.notify();}}
    }
  }
  async reviewContinuation(){
    // Advisory only; risk reconciliation always runs first. Review one position per tick.
    const r=this.active().filter(r=>!this.exitsSuspended(r)&&r.exitPolicy==='manual-profit-60s-loss'&&r.netEstimate>0&&Date.now()-(r.reviewAt||0)>=30000).sort((a,b)=>(a.reviewAt||0)-(b.reviewAt||0))[0];
    if(!r)return;
    r.reviewAt=Date.now();
    try{
      const raw=await this.api.call('GET','/fapi/v1/klines',{symbol:r.symbol,interval:'1m',limit:25},false);
      const trend=await this.api.call('GET','/fapi/v1/klines',{symbol:r.symbol,interval:'5m',limit:25},false);
      const now=Date.now()+this.api.offset;
      const check=(raw,ms)=>{
        breakout(raw,now,ms); // Validate OHLC and continuity, even without a breakout.
        const bars=raw.filter(b=>number(b[6])<now);
        if(bars.length<21||now-number(bars.at(-1)[6])>ms+15000)throw Error('Stale candles');
        const mean=a=>a.reduce((v,b)=>v+number(b[4]),0)/a.length;
        const fast=mean(bars.slice(-5)),slow=mean(bars.slice(-20));
        const last=number(bars.at(-1)[4]),prev=number(bars.at(-2)[4]);
        return r.side==='BUY'?last>fast&&fast>slow&&last>prev:last<fast&&fast<slow&&last<prev;
      };
      r.continuation=check(raw,60000)&&check(trend,300000)?'1m and 5m trend support this direction; profit is not guaranteed':'Continuation weakened or mixed; review for manual profit-taking';
    }catch(e){r.continuation='Trend review unavailable: '+e.message;}
    this.save();this.notify();
  }
  async tick(){
    if(!this.connected||this.busy)return;this.busy=true;
    try{
      if(!this.tradingReady){await this.refreshBalance();return;}
      await this.refresh();await this.reconcile();if(Date.now()-this.lastIncome>15000)await this.updateIncome();
      if(this.auto&&Date.now()-this.metaAt>600000){const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');for(const symbol of [...this.meta.keys()]){const m=info.symbols.find(x=>x.symbol===symbol&&x.status==='TRADING');if(m)this.meta.set(symbol,m);else this.meta.delete(symbol);}this.symbols=[...this.meta.keys()].sort();this.metaAt=Date.now();}
      if(!this.experimentActive()&&this.state.startedAt&&this.sessionNet()>=100){this.state.goal=true;this.pause('Session $100 goal reached; new entries paused. Manual-profit positions remain open.');this.save();}
      if(!this.experimentActive()&&this.state.goal)for(const r of this.active().filter(r=>r.exitPolicy!=='manual-profit-60s-loss'))await this.close(r.symbol,'$100 session goal');
      if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))this.pause('Unmanaged position detected; auto entries stopped.');
      if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))this.pause('Unmanaged orders detected; auto entries stopped.');
      await this.reviewContinuation();
      if(this.auto&&Date.now()-this.lastScan>=5000)await this.scan();
      this.block='';
    }catch(e){this.block=e.message;this.pause(e.message);}finally{this.busy=false;this.notify();}
  }
}
if(typeof module!=='undefined')module.exports={DemoAPI,DemoEngine,DemoError,rounded,breakout,twoMinuteBars,qualifySetup,experimentSignal,profitFloor,exitPrice,combinedValue,DEMO_BASE};
