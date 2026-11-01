'use strict';
const APP_VERSION='1.49';
const ENTRY_MARGIN=300,MAX_ENTRY_LEVERAGE=10;
const LEVERAGE_OVERRIDE_UNTIL=1793406469000; // 31 Oct 2026, 04:27:49 Asia/Dubai
const DEMO_BASE = 'https://demo-fapi.binance.com';
const PUBLIC = new Set(['/fapi/v1/time','/fapi/v1/exchangeInfo','/fapi/v1/klines','/fapi/v1/ticker/24hr','/fapi/v1/ticker/bookTicker','/fapi/v1/premiumIndex','/fapi/v1/assetIndex']);
const PRIVATE = {
  GET: new Set(['/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/positionSide/dual','/fapi/v1/multiAssetsMargin','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/commissionRate','/fapi/v1/income']),
  POST: new Set(['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/leverage','/fapi/v1/marginType']),
  DELETE: new Set(['/fapi/v1/algoOrder','/fapi/v1/order'])
};
const ENTRY_REJECTIONS=new Set([-2010,-2019,-2020,-2025,-2026,-2027,-2028,-1111,-1121,-4004,-4005,-4014,-4023,-4028,-4067,-4068,-4164,-4202,-4203,-4205,-4206,-4208,-4209,-4403]);
class DemoError extends Error { constructor(message, code=0, uncertain=false){super(message);this.code=code;this.uncertain=uncertain;} }
class DemoAPI {
  constructor(key, signingKey, fetcher=(url,options)=>fetch(url,options), crypt=crypto){this.key=key;this.signingKey=signingKey;this.fetcher=fetcher;this.crypt=crypt;this.offset=0;this.synced=0;this.blockUntil=0;}
  async call(method,path,params={},signed=true,options={}){
    const started=Date.now();let ok=false,code=0;
    try{const result=await this.request(method,path,params,signed,options);ok=true;return result;}
    catch(error){code=Number(error.code)||0;throw error;}
    finally{this.timings??=[];this.timings.push({at:Date.now(),method,path,signed,ms:Date.now()-started,ok,code});this.timings=this.timings.slice(-60);}
  }
  async request(method,path,params={},signed=true,options={}){
    if(!(signed?PRIVATE[method]?.has(path):method==='GET'&&PUBLIC.has(path)))throw new DemoError('Request is not allowed on this demo connector.');
    if(options.signal?.aborted)throw new DemoError('Scan read cancelled');
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
    const cancel=()=>ctl.abort();options.signal?.addEventListener('abort',cancel,{once:true});
    if(options.signal?.aborted)ctl.abort();
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
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
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
function aggregateMinutes(raw,now,minutes){
  if(![2,3,4,5].includes(minutes))throw new DemoError('Unsupported aggregation');
  twoMinuteBars(raw,now); // validate underlying 1m candle times
  const bars=raw.filter(b=>number(b[6])<now),out=[],ms=minutes*60000;
  for(let i=0;i+minutes<=bars.length;i++){
    if(number(bars[i][0])%ms!==0)continue;
    const group=bars.slice(i,i+minutes);
    if(group.some((b,j)=>number(b[0])!==number(group[0][0])+j*60000))throw new DemoError('Missing candles');
    out.push([group[0][0],group[0][1],Math.max(...group.map(b=>number(b[2]))),Math.min(...group.map(b=>number(b[3]))),group.at(-1)[4],group.reduce((n,b)=>n+number(b[5]),0),group.at(-1)[6]]);
    i+=minutes-1;
  }
  return out;
}
function aggregateFiveMinuteBars(raw,now,minutes){
  if(![10,15,20,30,60].includes(minutes))throw new DemoError('Unsupported longer timeframe');
  breakout(raw,now,300000);
  const bars=raw.filter(b=>number(b[6])<now),count=minutes/5,ms=minutes*60000,out=[];
  for(let i=0;i+count<=bars.length;i++){
    if(number(bars[i][0])%ms!==0)continue;
    const group=bars.slice(i,i+count);
    if(group.some((b,j)=>number(b[0])!==number(group[0][0])+j*300000||number(b[6])-number(b[0])!==299999))throw new DemoError('Missing longer-timeframe candles');
    out.push([group[0][0],group[0][1],Math.max(...group.map(b=>number(b[2]))),Math.min(...group.map(b=>number(b[3]))),group.at(-1)[4],group.reduce((n,b)=>n+number(b[5]),0),group.at(-1)[6]]);i+=count-1;
  }
  return out;
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
// Rule agreement describes observed candles, not the probability of winning.
function candleTrend(raw,now,ms=300000){
  breakout(raw,now,ms);
  const bars=raw.filter(b=>number(b[6])<now);
  if(bars.length<21||now-number(bars.at(-1)[6])>ms+15000)return {side:null,reason:'Confirmation candles unavailable or stale'};
  for(const b of bars)if(number(b[1])<number(b[3])||number(b[1])>number(b[2]))throw new DemoError('Invalid candle open');
  const mean=a=>a.reduce((n,b)=>n+number(b[4]),0)/a.length;
  const fast=mean(bars.slice(-5)),slow=mean(bars.slice(-20)),prior=mean(bars.slice(-6,-1)),last=number(bars.at(-1)[4]);
  return {side:last>fast&&fast>slow&&fast>prior?'BUY':last<fast&&fast<slow&&fast<prior?'SELL':null,fast,slow,closedAt:number(bars.at(-1)[6])};
}
function momentumSetup(raw,trend,now,intervalMs=60000,explain=()=>{}){
  const reject=reason=>{explain(reason);return null;};
  const direction=candleTrend(raw,now,intervalMs),confirmation=candleTrend(trend,now,300000);
  if(!direction.side)return reject(direction.reason||'No aligned candle momentum');
  if(confirmation.side!==direction.side)return reject('5m trend does not confirm current momentum');
  const bars=raw.filter(b=>number(b[6])<now),last=bars.at(-1),previous=bars.at(-2),buy=direction.side==='BUY';
  const open=number(last[1]),close=number(last[4]),high=number(last[2]),low=number(last[3]),range=high-low;
  if(!(buy?close>open&&close>number(previous[4]):close<open&&close<number(previous[4])))return reject('Latest candle is reversing or flat');
  const volumeMean=bars.slice(-21,-1).reduce((n,b)=>n+number(b[5]),0)/20;
  const volumeRatio=volumeMean>0?number(last[5])/volumeMean:0;
  const body=range>0?Math.abs(close-open)/range:0,closeStrength=range>0?(buy?close-low:high-close)/range:0;
  if(body<.4||closeStrength<.65)return reject('Candle body or close does not confirm direction');
  if(volumeRatio<.8)return reject('Volume below 0.8× recent average');
  const atr=bars.slice(-20).reduce((n,b,i)=>{const prev=number(bars[bars.length-21+i][4]);return n+Math.max(number(b[2])-number(b[3]),Math.abs(number(b[2])-prev),Math.abs(number(b[3])-prev));},0)/20;
  if(!(atr>0)||range>2*atr||Math.abs(close-direction.fast)>2*atr)return reject('Candle is too extended to chase');
  const strength=1+Number(volumeRatio>=1.2)+Number(body>=.65&&closeStrength>=.85);
  return {side:direction.side,price:close,close:number(last[6]),high,low,atr,stopDistance:1.5*atr,qualityConfirmed:true,strength,leverage:strength===3?8:strength===2?5:3,volumeRatio,body,closeStrength,observedChangePct:(close/open-1)*100,setupType:'momentum',invalidationPrice:direction.fast,intervalMs};
}
function entryPriceReason(price,signal){
  if(Math.abs(price-signal.price)>.5*signal.atr)return 'Price moved too far from the confirmed candle';
  const boundary=signal.setupType==='momentum'?signal.invalidationPrice:signal.side==='BUY'?signal.high:signal.low;
  if(!Number.isFinite(boundary)||(signal.side==='BUY'?price<=boundary:price>=boundary))return signal.setupType==='momentum'?'Momentum reversed before entry':'Breakout reversed before entry';
  return null;
}
function signalLeverageCeiling(signal,market,now){
  const strength=Number(signal.strength),base=strength>=3?10:strength>=2?5:3;
  const fresh=market&&Number.isFinite(market.closedAt)&&now>=market.closedAt&&now-market.closedAt<=315000;
  return fresh&&market.side===signal.side?base:Math.min(3,base);
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
function recoverySignal(raw,trend,side,now){
  const aligned=(input,ms)=>{
    breakout(input,now,ms);
    const bars=input.filter(b=>number(b[6])<now);
    if(bars.length<21||now-number(bars.at(-1)[6])>ms+15000)return false;
    const mean=a=>a.reduce((n,b)=>n+number(b[4]),0)/a.length;
    const fast=mean(bars.slice(-5)),slow=mean(bars.slice(-20)),last=bars.at(-1),previous=bars.at(-2);
    return {bars,last,ok:side==='BUY'?number(last[4])>fast&&fast>slow&&number(last[4])>number(previous[4]):number(last[4])<fast&&fast<slow&&number(last[4])<number(previous[4])};
  };
  const minute=aligned(raw,60000),five=aligned(trend,300000);
  if(!minute?.ok||!five?.ok)return false;
  const b=minute.last,open=number(b[1]),close=number(b[4]),high=number(b[2]),low=number(b[3]),range=high-low;
  const volume=minute.bars.slice(-21,-1).reduce((n,b)=>n+number(b[5]),0)/20;
  return range>0&&open>=low&&open<=high&&volume>0&&number(b[5])>=1.2*volume&&Math.abs(close-open)/range>=.4&&(side==='BUY'?close>open&&(close-low)/range>=.65:close<open&&(high-close)/range>=.65);
}
function entryMomentum(raw,side,now){
  breakout(raw,now,60000); // Validates closed candle continuity and OHLC.
  const bars=raw.filter(b=>number(b[6])<now);
  if(bars.length<21||now-number(bars.at(-1)[6])>75000)return {reason:'Latest closed 1m candle is unavailable or stale'};
  const last=bars.at(-1),previous=bars.at(-2),open=number(last[1]),close=number(last[4]),high=number(last[2]),low=number(last[3]),range=high-low;
  if(open<low||open>high)throw new DemoError('Invalid candle open');
  const mean=n=>bars.slice(-n).reduce((sum,b)=>sum+number(b[4]),0)/n;
  const buy=side==='BUY',fast=mean(5),slow=mean(20);
  if(!(buy?close>open&&close>number(previous[4])&&close>fast&&fast>slow:close<open&&close<number(previous[4])&&close<fast&&fast<slow))return {reason:'Latest 1m movement no longer confirms '+side};
  if(range<=0||Math.abs(close-open)/range<.4||(buy?(close-low)/range:(high-close)/range)<.65)return {reason:'Latest 1m candle body/close does not confirm '+side};
  const atr=bars.slice(-20).reduce((sum,b,i)=>sum+Math.max(number(b[2])-number(b[3]),Math.abs(number(b[2])-number(bars[bars.length-21+i][4])),Math.abs(number(b[3])-number(bars[bars.length-21+i][4]))),0)/20;
  return {atr,close,closedAt:number(last[6]),side};
}
function profitFloor(peak){if(!Number.isFinite(peak)||peak<=4)return null;if(peak>32)return 32+5*Math.max(0,Math.ceil((peak-32)/5)-1);let floor=4;while(peak>floor*2)floor*=2;return floor;}
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
function entryQuoteCheck(quote,mark,{symbol,side,qty,fee,lossLimit,tick,now}){
  const bid=number(quote.bidPrice),ask=number(quote.askPrice),markPrice=number(mark.markPrice);
  const bidQty=number(quote.bidQty),askQty=number(quote.askQty),quoteTime=number(quote.time),markTime=number(mark.time);
  if(quote.symbol!==symbol||bid<=0||ask<bid||markPrice<=0||bidQty<=0||askQty<=0)throw new DemoError('Invalid entry bid/ask quote');
  if(Math.abs(now-quoteTime)>15000||Math.abs(now-markTime)>15000)throw new DemoError('Entry bid/ask or mark price is stale');
  const entry=side==='BUY'?ask:bid,exit=side==='BUY'?bid:ask,sign=side==='BUY'?1:-1;
  const netAt=p=>(p-entry)*qty*sign-(entry+p)*qty*fee;
  const stopPrice=number(exitPrice(entry,qty,fee,-lossLimit,side,tick));
  const evidence={bid,ask,bidQty,askQty,quoteTime,markTime,markPrice,estimatedEntryPrice:entry,estimatedRoundTripFees:(entry+exit)*qty*fee,estimatedImmediateExitNet:netAt(exit),estimatedMarkNet:netAt(markPrice),plannedStopPrice:stopPrice};
  // Best quotes give an estimate, not a fill guarantee; deeper fills may differ.
  if(netAt(exit)<=-lossLimit)return {...evidence,reason:'Current spread and estimated fees already reach the $8 loss target'};
  if(side==='BUY'?markPrice<=stopPrice:markPrice>=stopPrice)return {...evidence,reason:'Current mark price would already trigger the planned $8 stop at the quoted fill'};
  return evidence;
}
function adaptiveLeveragePlan({price,atr,fee,lossLimit,side,tick,plan,maxLeverage=MAX_ENTRY_LEVERAGE}){
  if(!(price>0&&atr>0&&fee>=0&&fee<=.01&&lossLimit>0))throw new DemoError('Invalid adaptive sizing inputs');
  // Keep one recent 1m ATR plus estimated round-trip fees inside the loss target.
  // ATR is observed volatility, never a win probability or a profit forecast.
  if(!Number.isInteger(maxLeverage)||maxLeverage<1||maxLeverage>MAX_ENTRY_LEVERAGE)throw new DemoError('Invalid leverage ceiling');
  for(let leverage=maxLeverage;leverage>=1;leverage--){
    const size=plan(leverage),movementLoss=size.qty*atr;
    const estimatedFees=size.qty*(2*price+atr)*fee;
    if(movementLoss+estimatedFees>lossLimit+1e-8)continue;
    const stop=number(exitPrice(price,size.qty,fee,-lossLimit,side,tick));
    const stopDistance=side==='BUY'?price-stop:stop-price;
    if(stopDistance+1e-8<atr)continue;
    return {leverage,atr,movementLoss,estimatedFees,estimatedLossAtOneAtr:movementLoss+estimatedFees,stopDistance};
  }
  return null;
}
class DemoEngine {
  constructor(api,state,persist,notify=()=>{}){
    this.entryPolicy={margin:ENTRY_MARGIN,maxLeverage:MAX_ENTRY_LEVERAGE,strategy:'movers-momentum-v1'};
    this.appVersion=APP_VERSION;this.newRules=true;this.experimentUntil=LEVERAGE_OVERRIDE_UNTIL;this.overrideUntil=LEVERAGE_OVERRIDE_UNTIL;this.api=api;this.state=state||{version:1,records:[],startedAt:0,goal:false};this.persist=persist;this.notify=notify;this.auto=false;this.connected=false;this.busy=false;this.stopEpoch=0;this.account=null;this.positions=[];this.orders=[];this.algos=[];this.symbols=[];this.meta=new Map();this.cursor=0;this.scanned=[];this.lastScan=0;this.lastIncome=0;this.income=[];this.events=[];this.block='';this.balance=null;
    if(this.state.version!==1||!Array.isArray(this.state.records))throw new DemoError('Invalid demo journal. Do not start; inspect Binance Demo positions.');
    for(const r of this.state.records)if(!/^[A-Z0-9]+USDT$/.test(r.symbol)||!/^bd1_[a-zA-Z0-9_-]+$/.test(r.id)||!['BUY','SELL'].includes(r.side))throw new DemoError('Invalid saved demo order record.');
  }
  experimentActive(){return !this.newRules&&Date.now()+this.api.offset<this.experimentUntil;}
  exitsSuspended(r){return !this.newRules&&Number.isFinite(r.experimentUntil)&&Date.now()+this.api.offset<r.experimentUntil;}
  entryLeverage(signal,now=Date.now()+this.api.offset){return this.newRules?MAX_ENTRY_LEVERAGE:now<this.overrideUntil?50:signal.leverage;}
  syncDaily(){
    if(!this.newRules||this.state.goalStopAt)return;
    const now=Date.now()+this.api.offset,day=Math.floor((now+14400000)/86400000)*86400000-14400000;
    if(this.state.dayStart!==day){this.state.dayStart=day;this.state.dayOpenPnl=null;this.state.startedAt=Math.max(day,this.state.resetAt||0);this.state.goal=false;this.income=[];this.lastIncome=0;this.save();}
  }
  save(){this.persist(this.state);}
  event(text){this.events.unshift({at:Date.now(),text});this.events=this.events.slice(0,60);this.notify();}
  pause(reason){this.auto=false;this.stopEpoch++;this.scanController?.abort();if(reason)this.event(reason);}
  active(){return this.state.records.filter(r=>!r.closedAt&&!r.rejected);}
  owned(symbol){return this.active().find(r=>r.symbol===symbol);}
  position(symbol){return this.positions.find(p=>p.symbol===symbol&&number(p.positionAmt)!==0);}
  async control(fn,kind='action'){
    if(this.controlPending)return false;
    this.controlPending=true;const epoch=this.stopEpoch;this.notify();
    try{
      while(this.busy){if(kind==='start'&&epoch!==this.stopEpoch)return false;await new Promise(resolve=>setTimeout(resolve,50));}
      if(kind==='start'&&epoch!==this.stopEpoch)return false;
      this.busy=true;this.notify();try{await fn();return true;}finally{this.busy=false;}
    }finally{this.controlPending=false;this.notify();}
  }
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
    if(!this.tradingReady){this.positions=account.positions.map(p=>({...p,markPrice:p.markPrice??'—',entryPrice:p.entryPrice??'—',unRealizedProfit:p.unrealizedProfit??p.unRealizedProfit??'0'}));this.positionAt=this.accountAt;}
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
    for(const m of info.symbols)if(m.status==='TRADING'&&m.contractType==='PERPETUAL'&&m.quoteAsset==='USDT'&&m.marginAsset==='USDT'&&/^[A-Z0-9]+USDT$/.test(m.symbol))this.meta.set(m.symbol,m);
    this.symbols=[...this.meta.keys()].sort();if(!this.symbols.length)throw new DemoError('No eligible crypto futures found');
    this.metaAt=Date.now();await this.refresh();this.tradingReady=true;
  }
  async refresh({inventory=true,valuation=true}={}){
    const [account,positions]=await Promise.all([this.api.call('GET','/fapi/v3/account'),this.api.call('GET','/fapi/v3/positionRisk')]);
    if(!Array.isArray(account.assets)||!Array.isArray(positions))throw new DemoError('Invalid Binance position snapshot');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);}
    // Publish exchange positions before potentially slow order inventory reads.
    this.account=account;this.positions=positions;if(this.newRules&&this.state.dayStart&&this.state.dayOpenPnl===null){this.state.dayOpenPnl=positions.filter(p=>p.symbol.endsWith('USDT')).reduce((v,p)=>v+number(p.unRealizedProfit),0);this.save();}this.positionAt=Date.now();this.accountAt=this.positionAt;this.notify();
    if(this.newRules&&valuation){try{const indices=await this.api.call('GET','/fapi/v1/assetIndex',{},false);this.balance=combinedValue(account.assets,indices,Date.now()+this.api.offset);}catch{this.balance=null;}this.notify();}
    const [orders,algos]=inventory?await Promise.all([this.readOrderInventory('/fapi/v1/openOrders'),this.readOrderInventory('/fapi/v1/openAlgoOrders')]):[this.orders,this.algos];
    if(!Array.isArray(account.assets)||!Array.isArray(positions)||!Array.isArray(orders)||!Array.isArray(algos))throw new DemoError('Invalid Binance account or order response');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected. Auto entries stopped.');}
    this.account=account;this.positions=positions;this.orders=orders;this.algos=algos;if(inventory)this.ordersAt=Date.now();
    if(!this.newRules&&valuation){try{const indices=await this.api.call('GET','/fapi/v1/assetIndex',{},false);this.balance=combinedValue(account.assets,indices,Date.now()+this.api.offset);}catch{this.balance=null;}}
    this.notify();
  }
  async readOrderInventory(path){
    this.inventoryModes??={};this.inventoryCache??={};
    if(!this.inventoryModes[path]){
      try{const all=await this.api.call('GET',path);if(!Array.isArray(all))throw new DemoError('Invalid order inventory');return all;}
      catch(e){if(e.code!==0||e.uncertain||!this.orderUniverse?.length)throw e;this.inventoryModes[path]='per-symbol';this.event(this.newRules?'All-market orders unavailable; showing tracked/open-position symbols. Each new entry checks its own symbol.':'All-market order read failed. Checking each contract individually; this can take a few minutes.');}
    }
    if(this.newRules){
      this.scopedOrders=true;
      const symbols=[...new Set([...this.active().map(r=>r.symbol),...this.positions.filter(p=>number(p.positionAmt)!==0).map(p=>p.symbol)])];
      const rows=[];
      for(const symbol of symbols){const a=await this.api.call('GET',path,{symbol});if(!Array.isArray(a))throw new DemoError('Incomplete symbol order inventory');rows.push(...a);}
      return rows;
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
    if(!this.state.startedAt){this.income=[];this.lastIncome=0;this.incomeWindowStart=null;this.incomeWindowEnd=null;return;}
    // Pagination and fixed end time avoid silently dropping trades in busy accounts.
    const out=[],endTime=Date.now()+this.api.offset;
    if(endTime-this.state.startedAt>7*86400000)throw new DemoError('Session exceeds 7 days. Review results and start a new session when flat.');
    for(let page=1;page<=20;page++){
      const rows=await this.api.call('GET','/fapi/v1/income',{startTime:this.state.startedAt,endTime,page,limit:1000});
      if(!Array.isArray(rows))throw new DemoError('Invalid income response');out.push(...rows);
      if(rows.length<1000){const complete=out.filter(x=>x.asset==='USDT'&&['REALIZED_PNL','COMMISSION','FUNDING_FEE'].includes(x.incomeType));for(const x of complete)number(x.income);this.income=complete;this.incomeWindowStart=this.state.startedAt;this.incomeWindowEnd=endTime;this.lastIncome=Date.now();return;}
    }
    throw new DemoError('Income history is incomplete. Entries paused.');
  }
  async ensureIncomeFresh(maxAge=5000){
    if(!this.lastIncome||this.incomeWindowStart!==this.state.startedAt||Date.now()-this.lastIncome>maxAge)await this.updateIncome();
  }
  incomeBreakdown(){
    let gains=0,losses=0,commission=0,funding=0;
    for(const x of this.income){const v=number(x.income);if(x.incomeType==='REALIZED_PNL'){if(v>0)gains+=v;else losses+=v;}else if(x.incomeType==='COMMISSION')commission+=v;else if(x.incomeType==='FUNDING_FEE')funding+=v;}
    const realized=gains+losses,net=realized+commission+funding;
    return {gains,losses,realized,commission,funding,net};
  }
  tradeReport(){
    const now=Date.now(),incomeReady=!!this.lastIncome&&this.incomeWindowStart===this.state.startedAt;
    const positionReady=!!this.positionAt;
    const complete=incomeReady&&positionReady&&now-this.lastIncome<=30000&&now-this.positionAt<=30000;
    return {
      appVersion:APP_VERSION,generatedAt:new Date().toISOString(),strategyValidatedForProfit:false,
      windowStart:this.state.startedAt??null,incomeSnapshotAt:this.lastIncome||null,positionSnapshotAt:this.positionAt||null,
      snapshotStatus:{complete,income:!incomeReady?'missing':now-this.lastIncome>30000?'stale':'loaded',positions:!positionReady?'missing':now-this.positionAt>30000?'stale':'loaded'},
      incomeWindowEnd:incomeReady?this.incomeWindowEnd:null,
      diagnostics:{scan:this.scanStats||null,lastEntry:this.entryTiming||null,requestTimingScope:'Elapsed includes queue, signing, network and response parsing; not a network ping.',marketContext:this.marketContext||null,requests:(this.api.timings||[]).slice(-40),recentChecks:this.scanned.slice(0,20).map(s=>({symbol:s.symbol,phase:s.phase,reason:s.reason,at:s.at,scanMs:s.scanMs,candleClosedAt:s.candleClosedAt}))},
      scope:'Account-wide USDT income; includes manual trades. Bot records are separate. Snapshots may be at different times.',
      totals:incomeReady?this.incomeBreakdown():null,unrealized:positionReady?this.unrealizedPnl():null,openingUnrealized:this.state.dayOpenPnl||0,netSession:complete?this.sessionNet():null,
      incomeRowsOmitted:incomeReady?Math.max(0,this.income.length-200):0,
      income:incomeReady?this.income.slice(-200).map(x=>({symbol:x.symbol,time:x.time,type:x.incomeType,income:x.income,asset:x.asset})):[],
      botRecords:this.state.records.slice(-50).map(r=>({entryAppVersion:r.entryAppVersion||null,symbol:r.symbol,side:r.side,at:r.at,closedAt:r.closedAt,status:r.entryStatus,rejected:!!r.rejected,entry:r.entry,quantity:r.filledQty??r.quantity,leverage:r.leverage,fee:r.fee,estimatedEntryMargin:r.estimatedEntryMargin,lossLimit:r.lossLimit,peak:r.peak,profitFloor:r.profitFloor,closeReason:r.closeReason||(r.closedAt?'Closed on Binance; cause unconfirmed':null),protectionError:r.protectionError||null,entryEvidence:r.entryEvidence}))
    };
  }
  async freshTradeReport(){
    // Called under control(): no overlapping scanner or account writes.
    await this.refresh();await this.updateIncome();
    const report=this.tradeReport();
    if(!report.snapshotStatus.complete)throw new DemoError('Fresh income and position snapshots are required. Report not copied; sync again.');
    return report;
  }
  unrealizedPnl(){return this.positions.filter(p=>p.symbol.endsWith('USDT')).reduce((s,p)=>s+number(p.unRealizedProfit),0);}
  sessionNet(){return this.income.reduce((s,x)=>s+number(x.income),0)+this.unrealizedPnl()-(this.newRules?(this.state.dayOpenPnl||0):0);}
  async enforceSessionGoal(){
    if(!this.newRules||!this.state.startedAt||(!this.state.goalStopAt&&(!this.lastIncome||this.sessionNet()<100)))return false;
    this.pause();
    if(!this.state.goalStopAt){this.state.goal=true;this.state.goalStopAt=Date.now()+this.api.offset;this.state.goalNet=this.sessionNet();this.save();this.event('$100 net session target reached. Closing bot positions; new entries locked.');}
    const failures=[];
    for(const r of [...this.active()]){
      if(!this.position(r.symbol)&&!r.pendingClose)continue;
      try{await this.close(r.symbol,'$100 net session target');}catch(error){failures.push(r.symbol+': '+error.message);}
    }
    this.block=failures.length?'Target reached; closure needs reconciliation: '+failures.join('; '):'$100 target reached. Auto stopped. Use New $100 session when flat to restart.';
    this.save();this.notify();if(failures.length)throw new DemoError(this.block);return true;
  }
  async start(){
    const epoch=this.stopEpoch;
    if(!this.connected)throw new DemoError('Connect demo credentials first');
    this.syncDaily();
    if(!this.tradingReady||Date.now()-this.metaAt>600000)await this.prepareTrading();else await this.refresh();
    if(epoch!==this.stopEpoch)return;
    if(this.newRules){await this.updateIncome();if(await this.enforceSessionGoal())return;}
    await this.reconcile();
    if(this.active().some(r=>r.pendingClose||(!r.protected&&!this.exitsSuspended(r))))throw new DemoError('Resolve pending or unprotected orders before starting.');
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol))||this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))throw new DemoError('Unmanaged positions or orders exist in this demo account. Close/cancel them in Binance before starting this bot.');
    if(!this.newRules&&this.state.goal&&!this.experimentActive())throw new DemoError('Session $100 goal reached. Use Earn $100 again when flat.');
    if(!this.state.startedAt){this.state.startedAt=Date.now()+this.api.offset;this.save();}
    await this.updateIncome();if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;this.save();throw new DemoError('Session goal already reached');}
    if(epoch!==this.stopEpoch)return;
    this.auto=true;this.block='';this.event(this.newRules?'Auto enabled · 1–5m/10m/15m/20m/30m/60m · $200 margin · adaptive leverage up to 50× · $8 planned loss · available USDT · net session $100 close-and-stop target':this.experimentActive()?'EXPERIMENT enabled · 50× · available USDT · no automatic exits on new positions until '+new Date(this.experimentUntil).toISOString():'Auto enabled · filtered signals · adaptive 3× / 5× / 8× cross · up to $100 margin per entry · $1,000 budget · $800 total margin cap');
  }
  async resetFromBinance(){
    this.pause('Refreshing Binance before reset.');
    // Force a complete fresh inventory, never rely on cached empty orders.
    this.inventoryCache={};
    await this.refresh();
    if(this.positions.some(p=>number(p.positionAmt)!==0)||this.orders.length||this.algos.length)
      throw new DemoError('Reset blocked: close positions and clear pending orders in Binance first.');
    if(!this.account?.assets.some(a=>a.asset==='USDT'&&Number.isFinite(Number(a.walletBalance))))
      throw new DemoError('Reset blocked: fresh USDT wallet is unavailable.');
    // A pending entry may have been accepted but not appeared in position reads yet.
    for(const r of this.active()){
      let order;
      try{order=await this.queryEntry(r);}catch(e){
        if(e.code===-2013&&!e.uncertain&&(r.observedOpen||r.entryStatus==='FILLED')&&!r.pendingClose&&Date.now()+this.api.offset-r.at>60000){r.closedAt=Date.now()+this.api.offset;continue;}
        throw e;
      }
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
  async again(){if(this.active().length||this.positions.some(p=>number(p.positionAmt)!==0)||this.orders.length||this.algos.length)throw new DemoError('Close positions and clear pending orders before another session');this.syncDaily();this.state.startedAt=Date.now()+this.api.offset;this.state.resetAt=this.state.startedAt;this.state.dayOpenPnl=0;this.state.goal=false;delete this.state.goalStopAt;delete this.state.goalNet;this.income=[];this.lastIncome=0;this.save();await this.start();}
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
    const timing={symbol,startedAt:Date.now(),stages:[]};this.entryTiming=timing;
    const recordsBefore=this.state.records.length;
    try{return await this.enterChecked(symbol,signal);}catch(e){
      // Only skip pre-entry failures when no journaled/observed position can be at risk.
      if(this.state.records.length===recordsBefore&&!this.owned(symbol)&&!this.position(symbol)&&((!e.uncertain&&ENTRY_REJECTIONS.has(e.code))||e.code===-1000)){
        this.entryOutcome=symbol+' skipped ('+e.code+'): '+e.message+' Scanning continues.';
        this.event(this.entryOutcome);return false;
      }
      throw e;
    }finally{timing.totalMs=Date.now()-timing.startedAt;timing.outcome=this.entryOutcome;const last=timing.stages.at(-1);if(last)last.ms=Date.now()-last.at;const r=this.state.records.findLast(r=>r.symbol===symbol&&r.at>=timing.startedAt+(this.api.offset||0));if(r?.entryEvidence){r.entryEvidence.timing=timing;this.save();}}
  }
  async enterChecked(symbol,signal){
    const progress=reason=>{this.entryOutcome=reason;if(this.entryTiming){const stages=this.entryTiming.stages,previous=stages.at(-1);if(previous)previous.ms=Date.now()-previous.at;stages.push({label:reason,at:Date.now()});}const row=this.scanned.find(s=>s.symbol===symbol);if(row){row.reason=reason;row.entryMs=Date.now()-(this.entryTiming?.startedAt||Date.now());this.notify();}};
    const skip=reason=>{progress(reason);return false;};
    this.entryOutcome='Checking entry';
    const epoch=this.stopEpoch;
    if(!this.auto||this.state.goalStopAt||(!this.newRules&&this.state.goal&&!this.experimentActive())||this.owned(symbol))return skip('Auto paused, session goal reached, or already owned');
    if(!signal.qualityConfirmed||![3,5,8].includes(signal.leverage)||!Number.isFinite(signal.stopDistance)||signal.stopDistance<=0)return skip('Signal validation failed');
    if(this.newRules&&!(signal.strength>=1))return skip('Candle momentum agreement is missing');
    if(this.newRules&&this.state.records.some(r=>r.entryStatus==='FILLED'&&Date.now()+this.api.offset-r.at<60000))return skip('Entry spacing: at least 60 seconds between entries');
    const experimental=this.experimentActive()&&signal.experimental===true;
    if(signal.experimental&&!experimental)return skip('Experiment expired; waiting for a normal signal');
    const lossLimit=this.newRules?8:signal.exitPolicy==='manual-profit-60s-loss'?5:9;
    if(this.state.records.some(r=>r.symbol===symbol&&(r.signalClose===signal.close||Date.now()-(r.closedAt||r.at)<(this.newRules&&r.closedAt?600000:60000))))return skip('Already traded this candle or re-entry cooldown (10 minutes after close)');
    progress('Checking Binance balance, positions and open orders');
    await this.refresh({inventory:!this.newRules,valuation:false});
    if(this.newRules&&await this.enforceSessionGoal())return skip('$100 net session target reached');
    if(!this.auto||epoch!==this.stopEpoch||this.position(symbol)||(!this.newRules&&(this.orders.some(o=>o.symbol===symbol)||this.algos.some(o=>o.symbol===symbol))))return skip('Auto changed or existing position/order');
    // Candidate-specific reads prevent stale cached inventories admitting duplicates.
    progress('Checking this symbol for existing orders');
    const inventories=await Promise.all(['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'].map(path=>this.api.call('GET',path,{symbol})));
    for(const existing of inventories){if(!Array.isArray(existing))throw new DemoError('Order check incomplete');if(existing.length)return skip('Existing Binance order on this symbol');}
    if(Date.now()-this.metaAt>900000)throw new DemoError('Exchange filters expired. Reconnect to refresh.');
    const m=this.meta.get(symbol),lot=m.filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=m.filters.find(f=>f.filterType==='LOT_SIZE'),priceFilter=m.filters.find(f=>f.filterType==='PRICE_FILTER');
    if(!lot||!normal||!priceFilter||!m.orderTypes.includes('MARKET'))return skip('Market-order filters unavailable');
    let momentum;
    if(this.newRules){
      progress('Rechecking current 1m momentum before entry');
      try{momentum=entryMomentum(await this.api.call('GET','/fapi/v1/klines',{symbol,interval:'1m',limit:30},false),signal.side,Date.now()+this.api.offset);}
      catch(error){if([-1003,429,418].includes(error.code))throw error;return skip('1m entry check unavailable; scanning continues: '+error.message);}
      if(momentum.reason)return skip(momentum.reason+'; scanning continues');
    }
    progress('Checking current entry price');
    const mark=await this.api.call('GET','/fapi/v1/premiumIndex',{symbol},false);const price=number(mark.markPrice);
    if(Math.abs(Date.now()+this.api.offset-number(mark.time))>15000||Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000)return skip('Signal or mark price became stale');
    if(!experimental){const reason=entryPriceReason(price,signal);if(reason)return skip(reason);}
    progress('Checking commission and position size');
    const feeInfo=await this.api.call('GET','/fapi/v1/commissionRate',{symbol}),fee=number(feeInfo.takerCommissionRate);
    if(fee<0||fee>.01)throw new DemoError('Unsupported commission rate');
    if(this.newRules&&2*signal.atr<=3*(2*price*fee))return skip('Estimated candle movement too small relative to round-trip commission');
    const usdt=this.account.assets.find(a=>a.asset==='USDT');if(!usdt)throw new DemoError('No USDT available for USDT cross-margin trades');
    if(this.state.budgetWalletBaseline===undefined){this.state.budgetWalletBaseline=number(usdt.walletBalance);this.save();}
    const capital=this.budgetStatus();
    const preferredLeverage=this.entryLeverage(signal);
    const step=number(lot.stepSize)>0?lot.stepSize:normal.stepSize;
    const minNotional=number(m.filters.find(f=>f.filterType==='MIN_NOTIONAL')?.notional||m.filters.find(f=>f.filterType==='NOTIONAL')?.minNotional||0);
    const available=number(usdt.availableBalance),marginRoom=Math.max(0,5000-capital.reserved);
    const minimumPlan=(candidate,entryPrice=price)=>{
      const quantity=rounded(Math.max(ENTRY_MARGIN*candidate/entryPrice,minNotional/entryPrice,number(lot.minQty),number(normal.minQty)),step,true);
      const qty=number(quantity),notional=qty*entryPrice;
      return {quantity,qty,notional};
    };
    if(this.newRules&&(available<ENTRY_MARGIN||marginRoom<ENTRY_MARGIN))return skip('Waiting for at least $300 free margin plus fees; scanning continues');
    if(this.newRules&&2*momentum.atr<=3*(2*price*fee))return skip('Recent 1m movement is too small relative to round-trip fees; scanning continues');
    const leverageCeiling=this.newRules?signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset):preferredLeverage;
    const adaptive=this.newRules?adaptiveLeveragePlan({price,atr:momentum.atr,fee,lossLimit,side:signal.side,tick:priceFilter.tickSize,plan:minimumPlan,maxLeverage:leverageCeiling}):null;
    if(this.newRules&&!adaptive)return skip('$300 margin cannot fit recent 1m volatility, fees and Binance price ticks within the $8 stop, even at 1×; scanning continues');
    const requestedLeverage=this.newRules?adaptive.leverage:preferredLeverage;
    progress('Configuring '+requestedLeverage+'× based on recent volatility and fees');
    try{await this.api.call('POST','/fapi/v1/marginType',{symbol,marginType:'CROSSED'});}catch(e){if(e.code!==-4046)throw e;}
    let leverage,selectedLeverage,minimumSize;
    if(this.newRules){
      // Preserve $300 margin; lower the adaptive choice for exchange limits.
      const tryLeverage=async candidate=>{
        if(!this.auto||epoch!==this.stopEpoch)return false;
        try{
          const response=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:candidate});
          if(number(response.leverage)!==candidate)throw new DemoError('Selected leverage not accepted');
          const size=minimumPlan(candidate);
          if(size.notional>number(response.maxNotionalValue))return false;
          leverage=response;selectedLeverage=candidate;minimumSize=size;return true;
        }catch(e){
          if(e.uncertain||![-4028,-4202,-4203,-4205,-4206,-4208,-4209,-4403].includes(e.code))throw e;
          return false;
        }
      };
      if(!await tryLeverage(requestedLeverage)){
        // Binance accepts integer leverage below its ceiling. Find the exact
        // highest accepted value, including values absent from preset lists.
        let low=1,high=requestedLeverage-1;
        while(low<=high&&this.auto&&epoch===this.stopEpoch){
          const candidate=Math.floor((low+high)/2);
          if(await tryLeverage(candidate))low=candidate+1;else high=candidate-1;
        }
        // A successful capacity-ineligible probe can change the exchange setting.
        if(selectedLeverage&&this.auto&&epoch===this.stopEpoch){
          const confirmed=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:selectedLeverage});
          if(number(confirmed.leverage)!==selectedLeverage||minimumSize.notional>number(confirmed.maxNotionalValue))return skip('Binance leverage capacity changed; scanning continues');
          leverage=confirmed;
        }
      }
    }else{
      leverage=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:preferredLeverage});
      if(number(leverage.leverage)!==preferredLeverage)throw new DemoError('Selected leverage not accepted');
      selectedLeverage=preferredLeverage;
    }
    if(!selectedLeverage)return skip('No supported leverage permits $300 margin; scanning continues');
    let quantity,qty,notional;
    if(this.newRules){
      ({quantity,qty,notional}=minimumSize);
      const margin=notional/selectedLeverage,costs=notional*fee*2;
      if(margin+1e-8<ENTRY_MARGIN||margin>marginRoom+1e-8||margin+costs>available+1e-8)return skip('Not enough room for $300 margin plus fees at the selected leverage; scanning continues');
      if(qty>number(lot.maxQty)||qty>number(normal.maxQty))return skip('$300 order exceeds Binance quantity limits; scanning continues');
      if(costs>=lossLimit)return skip('Estimated trading fees already reach the $8 loss target at the required size; scanning continues');
      const stop=number(exitPrice(price,qty,fee,-lossLimit,signal.side,priceFilter.tickSize));
      if(signal.side==='BUY'?stop>=price:stop<=price)return skip('The $8 stop cannot fit Binance price ticks at this size; scanning continues');
      progress('Using '+selectedLeverage+'× with $300 estimated margin');
      const row=this.scanned.find(s=>s.symbol===symbol);if(row)row.leverage=selectedLeverage;
    }else{
      const budget=Math.min(100,(experimental?available:capital.free)/(1+2*selectedLeverage*fee),available/(1+2*selectedLeverage*fee));
      if(budget<=0){this.block='Waiting for room in the $1,000 budget ($200 reserve)';return skip(this.block);}
      quantity=rounded(Math.min(budget*selectedLeverage/price,experimental?Infinity:lossLimit/(signal.stopDistance+fee*(2*price+signal.stopDistance)),number(lot.maxQty),number(normal.maxQty)),step);qty=number(quantity);notional=qty*price;
      if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional||(!experimental&&notional*fee*2>=lossLimit)){this.block=symbol+': quantity/cost filter';return skip(this.block);}
      const cap=number(leverage.maxNotionalValue)*.95;
      if(cap<=0)return skip('No position capacity at selected leverage');
      if(notional>cap){
        quantity=rounded(Math.min(qty,cap/price),step);qty=number(quantity);notional=qty*price;
        if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional)return skip('Leverage position cap is below the minimum order size');
        progress('Reduced order size to fit Binance leverage limit');
      }
    }
    let quoteEvidence;
    if(this.newRules){
      progress('Checking current spread, mark price and $8 stop before entry');
      try{
        const [quote,currentMark]=await Promise.all([this.api.call('GET','/fapi/v1/ticker/bookTicker',{symbol},false),this.api.call('GET','/fapi/v1/premiumIndex',{symbol},false)]);
        const quotedPrice=number(signal.side==='BUY'?quote.askPrice:quote.bidPrice);
        if(quotedPrice<=0)return skip('Invalid entry quote; scanning continues');
        ({quantity,qty,notional}=minimumPlan(selectedLeverage,quotedPrice));
        quoteEvidence=entryQuoteCheck(quote,currentMark,{symbol,side:signal.side,qty,fee,lossLimit,tick:priceFilter.tickSize,now:Date.now()+this.api.offset});
        if(quoteEvidence.reason)return skip(quoteEvidence.reason+'; scanning continues');
        quoteEvidence.estimatedLossAtOneAtr=Math.max(0,-quoteEvidence.estimatedImmediateExitNet,-quoteEvidence.estimatedMarkNet)+qty*momentum.atr*(1+fee);
        const stopRoom=signal.side==='BUY'?quoteEvidence.markPrice-quoteEvidence.plannedStopPrice:quoteEvidence.plannedStopPrice-quoteEvidence.markPrice;
        if(quoteEvidence.estimatedLossAtOneAtr>lossLimit+1e-8||stopRoom+1e-8<momentum.atr)return skip('Fresh spread/mark movement leaves less than one recent 1m ATR inside the $8 stop; scanning continues');
        const quoteReason=entryPriceReason(quotedPrice,signal);if(quoteReason)return skip('Executable quote: '+quoteReason+'; scanning continues');
        if(qty>number(lot.maxQty)||qty>number(normal.maxQty)||notional>number(leverage.maxNotionalValue))return skip('Fresh quote size exceeds Binance order limits; scanning continues');
        const margin=notional/selectedLeverage;
        if(margin>marginRoom+1e-8||margin+quoteEvidence.estimatedRoundTripFees>available+1e-8)return skip('Fresh quote needs more margin plus fees than available; scanning continues');
      }catch(error){if([-1003,429,418].includes(error.code))throw error;return skip('Entry quote check unavailable; scanning continues: '+error.message);}
    }
    if(!this.auto||epoch!==this.stopEpoch||this.controlPending||this.shouldScan?.()===false)return skip(this.controlPending?'Manual action queued before entry dispatch':'Auto stopped before entry dispatch');
    if(this.newRules&&selectedLeverage>signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset))return skip('Market context became stale during checks; rechecking before higher leverage');
    if(this.newRules&&(Date.now()+this.api.offset-momentum.closedAt>75000||Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000))return skip('Entry confirmation became stale during checks; rechecking next scan');
    if(experimental&&!this.experimentActive())return skip('Experiment expired before order submission');
    if(this.entryLeverage(signal)!==preferredLeverage)return skip('50× window expired during checks; next scan uses adaptive leverage');
    const id='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
    const r={id,entryAppVersion:APP_VERSION,symbol,side:signal.side,quantity,fee,tick:priceFilter.tickSize,at:Date.now()+this.api.offset,signalClose:signal.close,signal,rulesVersion:this.newRules?3:1,experimentUntil:experimental?this.experimentUntil:null,leverage:selectedLeverage,lossLimit,exitPolicy:signal.exitPolicy,exits:[],protected:false};
    r.estimatedEntryMargin=notional/selectedLeverage;
    if(this.newRules)r.entryEvidence={oneMinute:momentum,...quoteEvidence,requestedLeverage,selectedLeverage,adaptiveSizing:{...adaptive,leverageCeiling},marketContext:this.marketContext||null,marketSource:signal.marketSource||{type:'full-market'}};
    r.sizingNote='Entry margin ≈ $'+(notional/selectedLeverage).toFixed(2)+' · estimated round-trip commission $'+(notional*fee*2).toFixed(2)+' · $300 target margin; adaptive leverage up to 10× based on candle agreement, BTC market context, 1m volatility, fees and exchange limits; $8 stop includes estimated fees; market fill margin may differ';
    this.state.records.push(r);this.save(); // Journal before dispatch; never duplicate an uncertain entry.
    progress('Submitting demo order');
    try{const order=await this.sendOnce('/fapi/v1/order',{symbol,side:r.side,positionSide:'BOTH',type:'MARKET',quantity,newClientOrderId:id,newOrderRespType:'RESULT'},()=>this.queryEntry(r));r.orderId=order.orderId;r.entryStatus=order.status;this.save();
      // Install protection directly from a confirmed fill before slower balance reads.
      if(order.status==='FILLED'&&Number(order.avgPrice)>0&&Number(order.executedQty)>0){
        const filled={entryPrice:order.avgPrice,positionAmt:r.side==='BUY'?order.executedQty:String(-Number(order.executedQty)),markPrice:order.avgPrice};r.entry=Number(order.avgPrice);r.filledQty=Number(order.executedQty);this.save();
        try{if(!this.exitsSuspended(r)){await this.ensureExit(r,filled,r.rulesVersion===3?'sl8':r.rulesVersion===2?'sl4':'sl',-(r.lossLimit??9));if(!r.closedAt&&r.exitPolicy!=='manual-profit-60s-loss')await this.ensureExit(r,filled,'tp',40);r.protected=!r.closedAt;}this.save();}
        catch(e){r.protectionError={at:Date.now()+this.api.offset,code:e.code||0,message:e.message};this.save();this.pause('Protection failed immediately after fill. '+e.message);await this.close(symbol,'Protection failure');throw e;}
      }
    }
    catch(e){
      if(!e.uncertain&&!r.entryStatus){
        r.rejected=true;this.save();
        if(ENTRY_REJECTIONS.has(e.code)){
          this.event(symbol+' entry rejected ('+e.code+'); scanning continues.');
          return skip('Binance rejected entry ('+e.code+'); continuing other coins');
        }
      }
      this.pause(e.message);throw e;
    }
    await this.refresh();await this.reconcile();this.entryOutcome=r.closedAt?'Entry closed during protection checks':'Entry submitted; status '+r.entryStatus;this.event(symbol+(this.exitsSuspended(r)?' demo entry submitted; automatic exits SUSPENDED until experiment expiry.':' demo entry submitted; confirmed fills and protection shown below.'));
  }
  async cancelExits(r,keepId=null){
    for(const e of r.exits||[]){if(e.cancelled||e.id===keepId)continue;try{await this.api.call('DELETE','/fapi/v1/algoOrder',{clientAlgoId:e.id});e.cancelled=true;this.save();}catch(err){const found=await this.queryExit(e).catch(q=>{if([-2011,-2013].includes(q.code))return {algoStatus:'NOT_FOUND'};throw q;});if(['CANCELED','CANCELLED','FINISHED','EXPIRED','REJECTED','NOT_FOUND'].includes(found.algoStatus)){e.cancelled=true;this.save();}else throw err;}}
  }
  async ensureExit(r,p,kind,target){
    let e=r.exits.find(e=>e.kind===kind&&!e.cancelled);
    if(e){if(this.newRules&&e.confirmed&&Date.now()-(e.verifiedAt||0)<15000)return;const q=await this.queryExit(e);if(q.algoStatus==='NEW'){e.confirmed=true;e.verifiedAt=Date.now();return;}throw new DemoError(r.symbol+' protective '+kind+' is '+q.algoStatus+'; checking position.');}
    const triggerPrice=exitPrice(number(p.entryPrice),Math.abs(number(p.positionAmt)),r.fee,target,r.side,r.tick);
    const mark=number(p.markPrice);if((kind==='tp')?(r.side==='BUY'?mark>=+triggerPrice:mark<=+triggerPrice):(r.side==='BUY'?mark<=+triggerPrice:mark>=+triggerPrice)){await this.close(r.symbol,kind+' threshold reached');return;}
    const prior=r.exits.filter(x=>x.kind===kind).length;
    e={id:r.id+'_'+kind+(prior?'_'+prior:''),kind,triggerPrice,confirmed:false};r.exits.push(e);this.save();
    const result=await this.sendOnce('/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:r.symbol,side:r.side==='BUY'?'SELL':'BUY',positionSide:'BOTH',type:kind==='tp'?'TAKE_PROFIT_MARKET':'STOP_MARKET',closePosition:'true',triggerPrice,workingType:'MARK_PRICE',priceProtect:'false',clientAlgoId:e.id},()=>this.queryExit(e));
    if(result.algoStatus!=='NEW')throw new DemoError('Protection was not confirmed NEW');
    e.confirmed=true;e.verifiedAt=Date.now();this.save();
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
      try{order=this.newRules&&r.observedOpen&&r.entryStatus==='FILLED'&&this.position(r.symbol)?{status:'FILLED',orderId:r.orderId}:await this.queryEntry(r);}catch(e){
        // A fresh position can prove that an ambiguous entry filled even when
        // the order query is temporarily unavailable. Protect it immediately.
        if(!this.position(r.symbol)){
          if(e.code===-2013&&!e.uncertain&&r.observedOpen&&!r.pendingClose&&!this.orders.some(o=>o.symbol===r.symbol)&&!this.algos.some(o=>o.symbol===r.symbol)){
            r.closedAt=Date.now()+this.api.offset;r.closeReason='Binance has no position or order; historical entry no longer available';for(const exit of r.exits||[])exit.cancelled=true;this.save();this.event(r.symbol+' reconciled flat after missing Binance history');continue;
          }
          throw e;
        }
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
        if(this.newRules&&(r.rulesVersion!==3||r.lossLimit!==8||r.recoveryExtended||r.exits.some(e=>e.kind==='sl12'&&!e.cancelled))){
          // Confirm the tighter exchange stop before removing any old exits.
          await this.ensureExit(r,p,'sl8',-8);if(r.closedAt||r.pendingClose)continue;
          const stop=r.exits.find(e=>e.kind==='sl8'&&!e.cancelled);
          await this.cancelExits(r,stop.id);
          r.rulesVersion=3;r.lossLimit=8;r.recoveryExtended=false;r.recoveryNote='Fixed $8 loss target; no recovery extension';r.exitPolicy='manual-profit-60s-loss';r.experimentUntil=null;r.lossSince=null;this.save();
        }
        await this.ensureExit(r,p,r.rulesVersion===3?'sl8':r.rulesVersion===2?'sl4':'sl',-(r.lossLimit??9));if(r.closedAt||r.pendingClose)continue;
        if(r.exitPolicy!=='manual-profit-60s-loss')await this.ensureExit(r,p,'tp',40);if(r.closedAt||r.pendingClose)continue;
        r.protected=true;
        let net=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.netEstimate=net;r.peak=Math.max(r.peak??-Infinity,net);
        if(r.exitPolicy==='manual-profit-60s-loss'){
          const raised=profitFloor(r.peak);
          // Recompute from the retained peak, replacing saved floors from older rules.
          r.profitFloor=raised;
          this.save();
          if(Number.isFinite(r.profitFloor)&&net<=r.profitFloor){await this.close(r.symbol,'Profit pullback to $'+r.profitFloor.toFixed(2)+' floor');continue;}
          net=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.netEstimate=net;
          const observedAt=Date.now()+this.api.offset;
          if(this.newRules)r.lossSince=null;
          else if(net<0){if(!Number.isFinite(r.lossSince))r.lossSince=observedAt;}else r.lossSince=null;
          this.save();
          if(net<=-(r.lossLimit??9)||(!this.newRules&&net<0&&observedAt-r.lossSince>=60000)){await this.close(r.symbol,net<=-(r.lossLimit??9)?'$'+(r.lossLimit??9)+' loss threshold':'Estimated net loss persisted for 60 seconds');continue;}
          this.save();continue;
        }
        if(net<=-9||net>=40||(r.peak>10&&net<=10)){await this.close(r.symbol,net<=-9?'$9 loss threshold':net>=40?'$40 profit threshold':'$10 profit floor');continue;}
        if(r.peak>10)await this.ensureExit(r,p,'floor',10);
        this.save();
      }catch(e){
        r.protectionError={at:Date.now()+this.api.offset,code:e.code||0,message:e.message};this.save();
        this.pause('Protection problem on '+r.symbol+'. Attempting reduce-only close.');
        // Never continue opening positions after a failed protective order.
        try{await this.close(r.symbol,'Protection failure');}catch(closeError){throw new DemoError('URGENT: '+r.symbol+' requires review in Binance Demo. '+closeError.message);}
        throw e;
      }
    }
  }
  async scanBars(symbol,interval,limit,controller){
    const ms=interval==='1m'?60000:300000,now=Date.now()+(this.api.offset||0),bucket=Math.floor(now/ms),key=symbol+':'+interval;
    this.candleCache??=new Map();const saved=this.candleCache.get(key);
    if(saved?.bucket===bucket&&saved.closedAt>=bucket*ms-1)return saved.bars;
    if(controller?.signal.aborted)throw new DemoError('Scan read cancelled');
    if(this.api instanceof DemoAPI){
      const at=Math.max(Date.now(),this.nextScanReadAt||0);this.nextScanReadAt=at+100;
      if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    }
    if(controller?.signal.aborted)throw new DemoError('Scan read cancelled');
    const bars=await this.api.call('GET','/fapi/v1/klines',{symbol,interval,limit},false,{signal:controller?.signal});
    if(controller?.signal.aborted)throw new DemoError('Scan read cancelled');
    const fetchedAt=Date.now()+(this.api.offset||0);breakout(bars,fetchedAt,ms);
    const closed=bars.filter(b=>number(b[6])<fetchedAt),closedAt=Number(closed.at(-1)?.[6])||0;
    if(closed.length>=21&&closedAt>=bucket*ms-1){this.candleCache.set(key,{bucket,closedAt,bars});if(this.candleCache.size>1200)this.candleCache.delete(this.candleCache.keys().next().value);}
    return bars;
  }
  async scanTrendBars(symbol,controller){return this.scanBars(symbol,'5m',300,controller);}
  async scanRiskCheck(){
    if(!this.connected||!this.tradingReady||!this.active().length||Date.now()-(this.positionAt||0)<5000)return;
    const positions=await this.api.call('GET','/fapi/v3/positionRisk');
    if(!Array.isArray(positions))throw new DemoError('Invalid position snapshot during scan');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected');}
    this.positions=positions;this.positionAt=Date.now();this.notify();
    await this.reconcile();await this.ensureIncomeFresh(5000);await this.enforceSessionGoal();
  }
  async refreshMovers(){
    if(!this.newRules||!this.meta.size||Date.now()-(this.moversCheckedAt||0)<60000)return;
    this.moversCheckedAt=Date.now();
    try{
      const rows=await this.api.call('GET','/fapi/v1/ticker/24hr',{},false);
      if(!Array.isArray(rows))throw new DemoError('Invalid movers response');
      const eligible=new Set(this.symbols),now=Date.now()+this.api.offset;
      const valid=rows.filter(x=>eligible.has(x.symbol)&&this.meta.has(x.symbol)&&Number.isFinite(Number(x.priceChangePercent))&&Number(x.lastPrice)>0&&Number(x.quoteVolume)>0&&Number.isFinite(Number(x.closeTime))&&Math.abs(now-Number(x.closeTime))<600000);
      const gainers=valid.filter(x=>Number(x.priceChangePercent)>0).sort((a,b)=>Number(b.priceChangePercent)-Number(a.priceChangePercent)).slice(0,10);
      const losers=valid.filter(x=>Number(x.priceChangePercent)<0).sort((a,b)=>Number(a.priceChangePercent)-Number(b.priceChangePercent)).slice(0,10);
      this.movers=[];for(let i=0;i<10;i++){if(gainers[i])this.movers.push({symbol:gainers[i].symbol,side:'BUY',change:Number(gainers[i].priceChangePercent)});if(losers[i])this.movers.push({symbol:losers[i].symbol,side:'SELL',change:Number(losers[i].priceChangePercent)});}
      this.moversAt=Date.now();this.moversNote=this.movers.length?'Futures 24h gainers → BUY; losers → SELL · refreshed '+new Date(this.moversAt).toLocaleTimeString():'No fresh eligible movers; scanning all markets';
    }catch(error){this.movers=[];this.moversNote='Movers unavailable; full-market scan continues. '+error.message;if([-1003,429,418].includes(error.code))throw error;}
    this.notify();
  }
  async refreshMarketContext(){
    if(!this.newRules||Date.now()-(this.marketCheckedAt||0)<60000)return;
    this.marketCheckedAt=Date.now();
    try{
      if(!this.meta.has('BTCUSDT'))throw new DemoError('BTCUSDT is not available in this demo market');
      const bars=await this.scanTrendBars('BTCUSDT');
      this.marketContext={...candleTrend(bars,Date.now()+this.api.offset),symbol:'BTCUSDT',at:Date.now()};
    }catch(error){
      this.marketContext={side:null,at:Date.now(),reason:error.message};
      if([401,403,418,429,451,-1003].includes(error.code))throw error;
    }
    this.notify();
  }
  async scanCandidate(symbol,mover,epoch,controller){
    const startedAt=Date.now();
      const raw=await this.scanBars(symbol,'1m',150,controller);
      const now=Date.now()+this.api.offset;
      if(raw.filter(b=>number(b[6])<now).length<21)return {symbol,mover,signal:null,reason:'Not enough closed candle history',foundCandidate:false,intervalMs:60000,scanMs:Date.now()-startedAt,candleClosedAt:null};
      let intervalMs=60000,signal=null,reason='No qualifying closed 1–5m / 10m / 15m / 20m / 30m / 60m setup',trend=null,foundCandidate=false;
      if(this.experimentActive()){signal=experimentSignal(raw,now);reason='Experiment: no fresh directional candle';}
      else for(const minutes of [1,2,3,4,5]){
        const bars=minutes===1?raw:aggregateMinutes(raw,now,minutes);
        const candidate=breakout(bars,now,minutes*60000);
        if(!this.newRules&&!candidate)continue;
        if(!trend)trend=await this.scanTrendBars(symbol,controller);
        let qualified=candidate?qualifySetup(candidate,bars,trend,Date.now()+this.api.offset,r=>reason=minutes+'m: '+r,300000):null;
        if(!qualified&&this.newRules)qualified=momentumSetup(bars,trend,Date.now()+this.api.offset,minutes*60000,r=>reason=minutes+'m: '+r);
        if(candidate||qualified)foundCandidate=true;
        if(qualified&&mover&&qualified.side!==mover.side){reason='Mover priority awaits a '+mover.side+' confirmation; checking other timeframes';continue;}
        if(qualified){intervalMs=minutes*60000;signal={...qualified,exitPolicy:'manual-profit-60s-loss',intervalMs};break;}
      }
      if(!signal&&!this.experimentActive()&&raw.length>=21){
        if(!trend)trend=await this.scanTrendBars(symbol,controller);
        for(const minutes of [10,15,20,30,60]){
          if(!this.auto||epoch!==this.stopEpoch)break;
          const bars=aggregateFiveMinuteBars(trend,Date.now()+this.api.offset,minutes),candidate=breakout(bars,Date.now()+this.api.offset,minutes*60000);
          if(!this.newRules&&!candidate)continue;
          let qualified=candidate?qualifySetup(candidate,bars,trend,Date.now()+this.api.offset,r=>reason=minutes+'m: '+r,300000):null;
          if(!qualified&&this.newRules)qualified=momentumSetup(bars,trend,Date.now()+this.api.offset,minutes*60000,r=>reason=minutes+'m: '+r);
          if(candidate||qualified)foundCandidate=true;
          if(qualified&&mover&&qualified.side!==mover.side){reason='Mover priority awaits a '+mover.side+' confirmation; checking other timeframes';continue;}
          if(qualified){intervalMs=minutes*60000;signal={...qualified,exitPolicy:'manual-profit-60s-loss',intervalMs};break;}
        }
      }
      if(signal&&mover&&signal.side!==mover.side){reason='Mover priority awaits a '+mover.side+' confirmation; opposite signal skipped';signal=null;}
      if(signal)signal.marketSource=mover?{type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change}:{type:'full-market'};
      return {symbol,mover,signal,reason,foundCandidate,intervalMs,scanMs:Date.now()-startedAt,candleClosedAt:Number(raw.filter(b=>Number(b[6])<Date.now()+(this.api.offset||0)).at(-1)?.[6])||null};
  }
  async scan(){
    if(!this.auto||!this.symbols.length||this.shouldScan?.()===false)return;
    const epoch=this.stopEpoch;this.lastScan=Date.now();const startedAt=Date.now();
    await this.refreshMovers();await this.refreshMarketContext();
    this.rechecks=this.rechecks||new Map();
    const due=[...this.rechecks].filter(([symbol,v])=>this.symbols.includes(symbol)&&!this.owned(symbol)&&Date.now()-v.seen<300000&&Date.now()-v.checked>=30000).sort((a,b)=>a[1].checked-b[1].checked).slice(0,4).map(([symbol])=>symbol);
    const priority=new Map(),movers=(this.movers||[]).filter(m=>this.symbols.includes(m.symbol)&&!this.owned(m.symbol));
    const moverBySymbol=new Map(movers.map(m=>[m.symbol,m]));
    this.moverCursor=this.moverCursor||0;
    for(let i=0;i<Math.min(8,movers.length);i++){const mover=movers[this.moverCursor++%movers.length];priority.set(mover.symbol,mover);}
    const batch=[...new Set([...priority.keys(),...due])];
    for(let i=0;i<Math.min(priority.size?4:12,this.symbols.length);i++){const symbol=this.symbols[this.cursor++%this.symbols.length];if(!batch.includes(symbol))batch.push(symbol);}
    for(const [symbol,v] of this.rechecks)if(Date.now()-v.seen>=300000)this.rechecks.delete(symbol);
    const controller=new AbortController();this.scanController=controller;
    const pending=new Map();let next=0,completed=0,errors=0;
    this.scanStats={startedAt,concurrency:3,planned:batch.length,completed:0,dataErrors:0};
    const launch=()=>{
      while(pending.size<3&&next<batch.length&&this.auto&&epoch===this.stopEpoch&&!this.controlPending){
        const symbol=batch[next++];if(this.owned(symbol))continue;
        const request=this.scanCandidate(symbol,moverBySymbol.get(symbol),epoch,controller).then(value=>({symbol,value}),error=>({symbol,error}));
        pending.set(symbol,request);
      }
    };
    try{
      launch();
      while(pending.size&&this.auto&&epoch===this.stopEpoch&&!this.controlPending){
        await this.scanRiskCheck();
        if(!this.auto||epoch!==this.stopEpoch||this.controlPending)break;
        let timer;const result=await Promise.race([...pending.values(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);clearTimeout(timer);
        if(!result)continue;
        pending.delete(result.symbol);launch();
        if(!this.auto||epoch!==this.stopEpoch||this.controlPending)break;
        const {symbol,error}=result;
        if(error&&[401,403,418,429,451,-1003].includes(error.code))throw error;
        const value=result.value||{symbol,reason:'Market data unavailable; continuing other coins: '+error.message,scanMs:0};
        const {mover,signal,reason,foundCandidate,intervalMs,scanMs,candleClosedAt}=value;
        if(error)errors++;
        if(foundCandidate)this.rechecks.set(symbol,{seen:Date.now(),checked:Date.now()});else if(this.rechecks.has(symbol))this.rechecks.get(symbol).checked=Date.now();
        this.scanChecked=(this.scanChecked||0)+1;completed++;
        this.scanStats={startedAt,concurrency:3,planned:batch.length,completed,dataErrors:errors,elapsedMs:Date.now()-startedAt};
        this.scanned=this.scanned.filter(s=>s.symbol!==symbol);
        const row={symbol,source:mover?(mover.side==='BUY'?'Gainer ':'Loser ')+mover.change.toFixed(2)+'%':'Full-market / recheck',phase:error?'Data error':signal?'Entry checks':'Signal rules',reason:signal?'Confirmed '+(intervalMs/60000)+'m '+(signal.setupType||'breakout')+'; checking entry':reason,setupType:signal?.setupType||'breakout',side:signal?.side||'WAIT',strength:signal?.strength,leverage:signal&&!this.newRules?this.entryLeverage(signal):undefined,at:Date.now(),scanMs,candleClosedAt};
        this.scanned.unshift(row);this.scanned=this.scanned.slice(0,30);this.notify();
        if(signal&&this.auto&&epoch===this.stopEpoch&&!this.controlPending){
          try{
            await this.ensureIncomeFresh();if(this.newRules&&await this.enforceSessionGoal())return;
            if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;row.reason='Session goal reached; new entries paused';this.pause('Session goal reached');this.save();return;}
            await this.enter(symbol,signal);row.reason=this.entryOutcome;
            row.entryMs=this.entryTiming?.totalMs;row.phase=this.state.records.some(r=>r.symbol===symbol&&r.at>=row.at+(this.api.offset||0)&&!r.rejected)?'Order submitted':'Entry skipped';
          }catch(error){row.reason='Entry failed: '+error.message;row.phase='Entry error';throw error;}
          finally{this.notify();}
        }
      }
    }finally{
      controller.abort();if(this.scanController===controller)this.scanController=null;
      this.scanStats={startedAt,finishedAt:Date.now(),concurrency:3,planned:batch.length,completed,dataErrors:errors,elapsedMs:Date.now()-startedAt};this.notify();
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
    if(!this.connected||this.busy||this.controlPending)return;this.busy=true;
    try{
      this.syncDaily();
      if(!this.tradingReady){await this.refreshBalance();return;}
      if(Date.now()-(this.lastFullCheck||0)>=5000||this.state.dayOpenPnl===null){await this.refresh();this.lastFullCheck=Date.now();}
      await this.reconcile();
      if(this.newRules){await this.ensureIncomeFresh(5000);if(await this.enforceSessionGoal()){await this.reconcile();await this.updateIncome();return;}}
      else if(Date.now()-this.lastIncome>15000)await this.updateIncome();
      if(this.auto&&Date.now()-this.metaAt>600000){const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');for(const symbol of [...this.meta.keys()]){const m=info.symbols.find(x=>x.symbol===symbol&&x.status==='TRADING');if(m)this.meta.set(symbol,m);else this.meta.delete(symbol);}this.symbols=[...this.meta.keys()].sort();this.metaAt=Date.now();}
      if(!this.newRules&&!this.experimentActive()&&this.state.startedAt&&this.sessionNet()>=100){this.state.goal=true;this.pause('Session $100 goal reached; new entries paused. Manual-profit positions remain open.');this.save();}
      if(!this.newRules&&!this.experimentActive()&&this.state.goal)for(const r of this.active().filter(r=>r.exitPolicy!=='manual-profit-60s-loss'))await this.close(r.symbol,'$100 session goal');
      if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))this.pause('Unmanaged position detected; auto entries stopped.');
      if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))this.pause('Unmanaged orders detected; auto entries stopped.');
      if(this.auto&&Date.now()-this.lastScan>=1000)await this.scan();
      await this.scanRiskCheck();await this.reviewContinuation();
      this.block='';
    }catch(e){this.block=e.message;this.pause(e.message);}finally{this.busy=false;this.notify();}
  }
}
if(typeof module!=='undefined')module.exports={ENTRY_MARGIN,MAX_ENTRY_LEVERAGE,candleTrend,momentumSetup,entryPriceReason,signalLeverageCeiling,DemoAPI,DemoEngine,DemoError,rounded,breakout,twoMinuteBars,aggregateMinutes,aggregateFiveMinuteBars,qualifySetup,experimentSignal,profitFloor,recoverySignal,entryMomentum,entryQuoteCheck,adaptiveLeveragePlan,exitPrice,combinedValue,DEMO_BASE};

