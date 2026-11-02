'use strict';
const APP_VERSION='1.57';
const ENTRY_MARGIN=300,MAX_ENTRY_LEVERAGE=10;
const ENTRY_VOLATILITY_ALLOWANCE=20;
const LEVERAGE_OVERRIDE_UNTIL=1793406469000; // 31 Oct 2026, 04:27:49 Asia/Dubai
const DEMO_BASE = 'https://demo-fapi.binance.com';
const PUBLIC = new Set(['/fapi/v1/time','/fapi/v1/exchangeInfo','/fapi/v1/klines','/fapi/v1/ticker/24hr','/fapi/v1/ticker/bookTicker','/fapi/v1/depth','/fapi/v1/premiumIndex','/fapi/v1/assetIndex']);
const PRIVATE = {
  GET: new Set(['/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/positionSide/dual','/fapi/v1/multiAssetsMargin','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/commissionRate','/fapi/v1/income','/fapi/v1/userTrades','/fapi/v1/leverageBracket']),
  POST: new Set(['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/leverage','/fapi/v1/marginType']),
  DELETE: new Set(['/fapi/v1/algoOrder','/fapi/v1/order'])
};
const ENTRY_REJECTIONS=new Set([400,-2010,-2019,-2020,-2025,-2026,-2027,-2028,-1111,-1121,-4004,-4005,-4014,-4016,-4023,-4024,-4028,-4067,-4068,-4131,-4164,-4202,-4203,-4205,-4206,-4208,-4209,-4403]);
const ENTRY_READ_PATHS=new Set(['/fapi/v1/userTrades','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/klines','/fapi/v1/premiumIndex','/fapi/v1/ticker/bookTicker','/fapi/v1/commissionRate','/fapi/v1/leverageBracket']);
const ENTRY_READ_TRANSIENT=new Set([0,-1000,-1001,-1006,-1007,408,500,502,503,504]);
const ACCOUNT_BLOCKS=new Set([401,403,418,429,451,-1002,-1003,-1011,-1015,-1021,-1022,-2014,-2015]);
class DemoError extends Error { constructor(message, code=0, uncertain=false){super(message);this.code=code;this.uncertain=uncertain;} }
class DemoAPI {
  constructor(key, signingKey, fetcher=(url,options)=>fetch(url,options), crypt=crypto){this.key=key;this.signingKey=signingKey;this.fetcher=fetcher;this.crypt=crypt;this.offset=0;this.synced=0;this.blockUntil=0;}
  async call(method,path,params={},signed=true,options={}){
    const started=Date.now();let ok=false,code=0;
    try{const result=await this.request(method,path,params,signed,options);ok=true;return result;}
    catch(error){code=Number(error.code)||0;error.requestMethod??=method;error.requestPath??=path;if(error.requestMethod==='GET')error.uncertain=false;throw error;}
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
        throw new DemoError(this.limitSource+' rate limit (HTTP '+r.status+'). Wait '+Math.ceil((this.blockUntil-Date.now())/1000)+' seconds. Auto waits for read recovery; uncertain orders are never blindly retried.',r.status,method!=='GET');
      }
      if(signed&&this.relayToken&&data.error==='Backend access token rejected')throw new DemoError('Local connection token rejected. Unlock saved keys and replace the token with the one from the running Windows backend.',401);
      if(signed&&this.relayToken&&data.error==='Unsupported demo request'){const error=new DemoError('Local backend does not support '+path+'. Update and restart the laptop connector.',400);error.backendUpdateRequired=true;error.source='local-backend';throw error;}
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
function entryPriceReason(price,signal,{tolerant=false}={}){
  if(!(Number.isFinite(price)&&price>0&&Number.isFinite(signal.price)&&signal.price>0&&Number.isFinite(signal.atr)&&signal.atr>0)||!['BUY','SELL'].includes(signal.side))return 'Invalid entry price or signal';
  if(Math.abs(price-signal.price)>(tolerant?.75:.5)*signal.atr)return 'Price moved too far from the confirmed candle';
  const boundary=signal.setupType==='momentum'?signal.invalidationPrice:signal.side==='BUY'?signal.high:signal.low;
  const retest=tolerant&&signal.setupType!=='momentum'?.1*signal.atr:0;
  const distance=(price-boundary)*(signal.side==='BUY'?1:-1);
  if(!Number.isFinite(boundary)||(retest?distance < -retest-1e-10:distance<=0))return signal.setupType==='momentum'?'Momentum reversed before entry':'Breakout reversed before entry';
  return null;
}
function signalLeverageCeiling(signal,market,now){
  const strength=Number(signal.strength),base=strength>=3?10:strength>=2?5:3;
  const fresh=market&&Number.isFinite(market.closedAt)&&now>=market.closedAt&&now-market.closedAt<=315000;
  return fresh&&market.side===signal.side?base:Math.min(3,base);
}
function selectEntryCandidate(primary,{price,fee,now,traded=()=>false,intervals=[1,2,3,4,5,10,15,20,30,60]}){
  const choices=[primary,...(Array.isArray(primary.alternatives)?primary.alternatives:[])].slice(0,10),checks=[];
  for(const candidate of choices){
    const {alternatives,...signal}=candidate,intervalMs=signal.intervalMs||300000;
    let reason;
    if(signal.side!==primary.side||!signal.qualityConfirmed||!(signal.strength>=1)||![3,5,8].includes(signal.leverage)||!(signal.stopDistance>0&&Number.isFinite(signal.stopDistance))||!(signal.atr>0&&Number.isFinite(signal.atr))||!Number.isFinite(signal.price))reason='Invalid or opposite-direction candidate';
    else if(!intervals.includes(intervalMs/60000)||!Number.isFinite(signal.close)||signal.close>=now||now-signal.close>intervalMs+15000)reason='Signal became stale';
    else if(traded(signal))reason='Already traded this candle';
    else reason=entryPriceReason(price,signal,{tolerant:true});
    if(!reason&&2*signal.atr<=3*(2*price*fee))reason='Estimated candle movement too small relative to round-trip commission';
    checks.push({minutes:intervalMs/60000,side:signal.side,setupType:signal.setupType||'breakout',reason:reason||'Entry candidate selected'});
    if(!reason)return {signal:{...signal,intervalMs},checks};
  }
  return {signal:null,checks};
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
  const hasStop=Number.isFinite(lossLimit)&&lossLimit>0;
  const stopPrice=hasStop?number(exitPrice(entry,qty,fee,-lossLimit,side,tick)):null;
  const evidence={bid,ask,bidQty,askQty,quoteTime,markTime,markPrice,estimatedEntryPrice:entry,estimatedRoundTripFees:(entry+exit)*qty*fee,estimatedImmediateExitNet:netAt(exit),estimatedMarkNet:netAt(markPrice),plannedStopPrice:stopPrice};
  // Best quotes give an estimate, not a fill guarantee; deeper fills may differ.
  if(hasStop&&netAt(exit)<=-lossLimit)return {...evidence,reason:'Current spread and estimated fees already reach the loss target'};
  if(hasStop&&(side==='BUY'?markPrice<=stopPrice:markPrice>=stopPrice))return {...evidence,reason:'Current mark price would already trigger the planned loss stop at the quoted fill'};
  return evidence;
}
function adaptiveLeveragePlan({price,atr,fee,lossLimit,side,tick,plan,maxLeverage=MAX_ENTRY_LEVERAGE,requireStop=true}){
  if(!(price>0&&atr>0&&fee>=0&&fee<=.01&&lossLimit>0))throw new DemoError('Invalid adaptive sizing inputs');
  // Bound entry exposure using one recent ATR plus fees; this need not be an exit.
  // ATR is observed volatility, never a win probability or a profit forecast.
  if(!Number.isInteger(maxLeverage)||maxLeverage<1||maxLeverage>MAX_ENTRY_LEVERAGE)throw new DemoError('Invalid leverage ceiling');
  for(let leverage=maxLeverage;leverage>=1;leverage--){
    const size=plan(leverage),movementLoss=size.qty*atr;
    const estimatedFees=size.qty*(2*price+atr)*fee;
    if(movementLoss+estimatedFees>lossLimit+1e-8)continue;
    const stop=requireStop?number(exitPrice(price,size.qty,fee,-lossLimit,side,tick)):null;
    const stopDistance=requireStop?(side==='BUY'?price-stop:stop-price):null;
    if(requireStop&&stopDistance+1e-8<atr)continue;
    return {leverage,atr,movementLoss,estimatedFees,estimatedLossAtOneAtr:movementLoss+estimatedFees,stopDistance};
  }
  return null;
}
function trialProfitFloor(peak){if(!Number.isFinite(peak)||peak<=2)return null;const levels=[2,4,8,10];if(peak<=10)return levels.filter(v=>v<peak).at(-1);return 10+5*Math.max(0,Math.ceil((peak-10)/5)-1);}
function netProfitFloor(peak){if(!Number.isFinite(peak)||peak<=2)return null;if(peak<=10)return Math.max(2,2*(Math.ceil(peak/2)-1));return 10+5*Math.max(0,Math.ceil((peak-10)/5)-1);}
class DemoEngine {
  constructor(api,state,persist,notify=()=>{}){
    this.entryPolicy={margin:ENTRY_MARGIN,maxLeverage:MAX_ENTRY_LEVERAGE,strategy:'movers-momentum-v2',lossLimit:5,takeProfit:null,profitExit:'net-trailing',profitFloors:[2,4,6,8,10],profitStepAbove10:5,lossReduction:.25,lossReductionAt:3,sessionExit:'close-bot-positions',volatilitySizingAllowance:ENTRY_VOLATILITY_ALLOWANCE,priceToleranceAtr:.75,breakoutRetestAtr:.1};
    this.scanAudit={startedAt:Date.now(),checked:0,qualified:0,submitted:0,skipped:0,entryErrors:0,dataErrors:0,lastCheckAt:null,lastSubmittedAt:null,lastResult:null};
    this.appVersion=APP_VERSION;this.newRules=true;this.experimentUntil=LEVERAGE_OVERRIDE_UNTIL;this.overrideUntil=LEVERAGE_OVERRIDE_UNTIL;this.api=api;this.state=state||{version:1,records:[],startedAt:0,goal:false};this.persist=persist;this.notify=notify;this.auto=false;this.connected=false;this.busy=false;this.stopEpoch=0;this.account=null;this.positions=[];this.orders=[];this.algos=[];this.symbols=[];this.meta=new Map();this.cursor=0;this.scanned=[];this.lastScan=0;this.lastIncome=0;this.income=[];this.events=[];this.block='';this.balance=null;
    if(this.state.version!==1||!Array.isArray(this.state.records))throw new DemoError('Invalid demo journal. Do not start; inspect Binance Demo positions.');
    for(const r of this.state.records)if(!/^[A-Z0-9]+USDT$/.test(r.symbol)||!/^bd1_[a-zA-Z0-9_-]+$/.test(r.id)||!['BUY','SELL'].includes(r.side))throw new DemoError('Invalid saved demo order record.');
  }
  trialActive(now=Date.now()+this.api.offset){
    const t=this.state.oneHourTrial;
    return !!(this.newRules&&t&&Number.isFinite(t.startedAt)&&Number.isFinite(t.until)&&t.until-t.startedAt===3600000&&!t.endedAt&&now>=t.startedAt&&now<t.until);
  }
  async startTrial(){
    if(!this.newRules)throw new DemoError('Update the engine before starting the one-hour experiment');
    if(this.trialActive())return false; // repeated clicks never extend an active hour
    const epoch=this.stopEpoch;await this.start();
    if(!this.auto||epoch!==this.stopEpoch)return false;
    const at=Date.now()+this.api.offset;
    this.state.oneHourTrial={id:'trial_'+at,startedAt:at,until:at+3600000,scope:'new-positions',lossExit:'any-negative-net',maxMargin:300,maxLeverage:150,entryStrategy:'confirmed-momentum-v1',profitFloors:[2,4,8,10],profitStep:5};
    this.save();this.event('One-hour Demo experiment started. Confirmed momentum/breakout setups only. Maximum exchange-allowed leverage up to 150×; up to $300 margin. Any negative estimated net triggers closure, including fees. New entries revert at '+new Date(at+3600000).toISOString()+'. Existing positions keep their recorded exits.');return true;
  }
  endTrial(){
    const t=this.state.oneHourTrial;if(!t||t.endedAt)return;
    t.endedAt=Date.now()+this.api.offset;this.save();this.event('Experiment entries ended. Normal entry rules restored. Experiment positions keep their recorded exits until closed.');
  }
  expireTrial(){const t=this.state.oneHourTrial;if(t&&!t.endedAt&&Date.now()+this.api.offset>=t.until)this.endTrial();}
  exitPollMs(){return this.active().some(r=>r.oneHourTrial)?1000:5000;}
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
  pause(reason){this.retryAt=0;this.retryAttempt=0;this.auto=false;this.stopEpoch++;this.scanController?.abort();if(reason)this.event(reason);}
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
  recordScanResult(row){
    const audit=this.scanAudit;if(!audit)return;
    audit.checked++;audit.lastCheckAt=Date.now();
    if(['BUY','SELL'].includes(row.side))audit.qualified++;
    if(row.phase==='Order submitted'){audit.submitted++;audit.lastSubmittedAt=Date.now();}
    if(row.phase==='Entry skipped')audit.skipped++;
    if(row.phase==='Entry error')audit.entryErrors++;
    if(row.phase==='Data error')audit.dataErrors++;
    audit.lastResult={symbol:row.symbol,phase:row.phase,reason:row.reason};
  }
  scanDiagnostics(){
    const now=Date.now(),audit=this.scanAudit||null,lastCompleted=audit?.lastCheckAt||this.scanned[0]?.at||null;
    const progressAt=lastCompleted||this.scanStats?.startedAt||this.lastScan||null;
    const elapsed=progressAt?Math.floor((now-progressAt)/1000):null;
    let status;
    if(!this.connected)status='Disconnected: no new entries can be sent.';
    else if(this.state.goalStopAt)status='$100 session stop is locked. Start a new session while flat to resume.';
    else if(!this.tradingReady)status='Balance connected; trading checks are incomplete. '+(this.block||'Use Retry connection.');
    else if(!this.auto)status='Auto is stopped. '+(this.block||'Use Start / Resume Demo to scan and enter.');
    else if(this.retryAt>Date.now())status='Auto enabled; temporary connection delay. Retrying in '+Math.ceil((this.retryAt-Date.now())/1000)+' seconds. '+(this.block||'');
    else if(this.controlPending)status='A manual action is queued or running; new entries wait for it.';
    else if(!this.symbols.length)status='No eligible markets have been loaded.';
    else if(elapsed!==null&&elapsed>90)status='No completed coin check for '+elapsed+' seconds. '+(this.block||this.entryOutcome||'Check connection and last scan times.');
    else status='Auto scanning. '+(audit?audit.checked+' completed coin checks; '+audit.qualified+' candle setups; '+audit.submitted+' confirmed order submissions; '+audit.skipped+' entry skips; '+(audit.entryErrors||0)+' entry errors; '+audit.dataErrors+' data errors.':'Detailed counters unavailable from this engine.')+(audit?.lastResult?' Latest: '+audit.lastResult.symbol+' — '+audit.lastResult.reason:' Waiting for first completed check.');
    return {reportType:'scan-diagnostics',appVersion:this.appVersion||null,generatedAt:new Date(now).toISOString(),status,connected:this.connected,tradingReady:!!this.tradingReady,auto:this.auto,retryAt:this.retryAt||null,busy:this.busy,controlPending:!!this.controlPending,block:this.block||null,entryPolicy:this.entryPolicy||null,oneHourTrial:this.state.oneHourTrial||null,trialActive:this.trialActive(),marketCount:this.symbols.length,lastScanStartedAt:this.lastScan||null,lastCompletedCheckAt:lastCompleted,scanAudit:audit,scan:this.scanStats||null,marketContext:this.marketContext||null,localSnapshotOnly:true,note:'No trades or fresh account requests are required. Counts are checks since this engine loaded, not unique coins or profit predictions.',recentChecks:this.scanned.slice(0,30).map(s=>({symbol:s.symbol,at:s.at,side:s.side,source:s.source,phase:s.phase,reason:s.reason,scanMs:s.scanMs,entryMs:s.entryMs,checks:s.checks,entryCandidates:s.entryCandidates})),requests:(this.api.timings||[]).slice(-30).map(r=>({at:r.at,method:r.method,path:r.path,ms:r.ms,ok:r.ok,code:r.code}))};
  }
  tradeReport(){
    const now=Date.now(),incomeReady=!!this.lastIncome&&this.incomeWindowStart===this.state.startedAt;
    const positionReady=!!this.positionAt;
    const complete=incomeReady&&positionReady&&now-this.lastIncome<=30000&&now-this.positionAt<=30000;
    return {
      appVersion:APP_VERSION,generatedAt:new Date().toISOString(),strategyValidatedForProfit:false,oneHourTrial:this.state.oneHourTrial||null,trialActive:this.trialActive(),
      windowStart:this.state.startedAt??null,incomeSnapshotAt:this.lastIncome||null,positionSnapshotAt:this.positionAt||null,
      snapshotStatus:{complete,income:!incomeReady?'missing':now-this.lastIncome>30000?'stale':'loaded',positions:!positionReady?'missing':now-this.positionAt>30000?'stale':'loaded'},
      incomeWindowEnd:incomeReady?this.incomeWindowEnd:null,
      diagnostics:{scan:this.scanStats||null,lastEntry:this.entryTiming||null,requestTimingScope:'Elapsed includes queue, signing, network and response parsing; not a network ping.',marketContext:this.marketContext||null,requests:(this.api.timings||[]).slice(-40),recentChecks:this.scanned.slice(0,20).map(s=>({symbol:s.symbol,phase:s.phase,reason:s.reason,at:s.at,scanMs:s.scanMs,candleClosedAt:s.candleClosedAt}))},
      scope:'Account-wide USDT income; includes manual trades. Bot records are separate. Snapshots may be at different times.',
      totals:incomeReady?this.incomeBreakdown():null,unrealized:positionReady?this.unrealizedPnl():null,openingUnrealized:this.state.dayOpenPnl||0,netSession:complete?this.sessionNet():null,
      incomeRowsOmitted:incomeReady?Math.max(0,this.income.length-200):0,
      income:incomeReady?this.income.slice(-200).map(x=>({symbol:x.symbol,time:x.time,type:x.incomeType,income:x.income,asset:x.asset})):[],
      botRecords:this.state.records.slice(-50).map(r=>({entryAppVersion:r.entryAppVersion||null,oneHourTrial:r.oneHourTrial||null,symbol:r.symbol,side:r.side,at:r.at,closedAt:r.closedAt,status:r.entryStatus,rejected:!!r.rejected,entry:r.entry,quantity:r.filledQty??r.quantity,leverage:r.leverage,fee:r.fee,estimatedEntryMargin:r.estimatedEntryMargin,lossLimit:r.lossLimit,takeProfit:r.takeProfit??null,exitPolicy:r.exitPolicy||null,exitsReady:!!r.exitsReady,peak:r.peak,profitFloor:r.profitFloor,closeReason:r.closeReason||(r.closedAt?'Closed on Binance; cause unconfirmed':null),protectionError:r.protectionError||null,entryEvidence:r.entryEvidence,tradeAccounting:r.tradeAccounting||null,trailPeak:r.trailPeak??null,lossReduction:r.lossReduction||null,closingEstimate:r.closingEstimate||null,estimateError:r.estimateError||null}))
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
  async estimateSessionClose(){
    let net=this.sessionNet(),closingFees=0;
    for(const r of this.active()){
      const p=this.position(r.symbol);if(!p)continue;
      await this.closingEstimate(r,p,{forceAccounting:true});const estimate=r.closingEstimate,ledger=r.tradeAccounting;
      const alreadyCounted=this.income.filter(x=>x.symbol===r.symbol&&Number(x.time)>=Math.max(r.at,this.state.startedAt)&&['REALIZED_PNL','COMMISSION','FUNDING_FEE'].includes(x.incomeType)).reduce((sum,x)=>sum+number(x.income),0);
      net+=ledger.windowBooked-alreadyCounted+estimate.gross-estimate.closingFee-number(p.unRealizedProfit);closingFees+=estimate.closingFee;
    }
    if(!Number.isFinite(net))throw new DemoError('Net session closing estimate unavailable');
    net=Math.round(net*1e8)/1e8;this.sessionCloseEstimate={net,closingFees,at:Date.now()+this.api.offset};return net;
  }
  async enforceSessionGoal(){
    if(!this.newRules||!this.state.startedAt||(!this.state.goalStopAt&&(!this.lastIncome||this.sessionNet()<100)))return false;
    const closingNet=this.state.goalStopAt?this.state.goalNet:await this.estimateSessionClose();
    if(!this.state.goalStopAt&&closingNet<100)return false;
    this.pause();
    if(!this.state.goalStopAt){this.state.goal=true;this.state.goalStopAt=Date.now()+this.api.offset;this.state.goalNet=closingNet;this.save();this.event('$100 net session target reached. Closing all bot positions; new entries locked.');}
    const failures=[];
    for(const r of [...this.active()]){
      try{
        // A partial/pending entry must not refill after the session close.
        if(r.entryStatus!=='FILLED'){
          let entry=await this.queryEntry(r);
          if(['NEW','PARTIALLY_FILLED'].includes(entry.status)){
            await this.api.call('DELETE','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.id});
            entry=await this.queryEntry(r);
          }
          if(!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(entry.status))throw new DemoError('Entry cancellation or final status remains unresolved');
          r.entryStatus=entry.status;this.save();
        }
        await this.close(r.symbol,'$100 net session target');
      }catch(error){failures.push(r.symbol+': '+error.message);}
    }
    for(const r of this.active())if(!failures.some(message=>message.startsWith(r.symbol+': ')))failures.push(r.symbol+': awaiting flat position confirmation');
    this.block=failures.length?'$100 target reached; closure needs reconciliation: '+failures.join('; '):'$100 target reached. Bot positions closed and new entries stopped. Use New $100 session when flat to restart.';
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
    if(this.active().some(r=>r.pendingClose||r.lossReduction?.status==='PENDING'||(!(this.newRules?r.exitsReady:r.protected)&&!this.exitsSuspended(r))))throw new DemoError('Resolve pending orders or unverified exits before starting.');
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol))||this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))throw new DemoError('Unmanaged positions or orders exist in this demo account. Close/cancel them in Binance before starting this bot.');
    if(!this.newRules&&this.state.goal&&!this.experimentActive())throw new DemoError('Session $100 goal reached. Use Earn $100 again when flat.');
    if(!this.state.startedAt){this.state.startedAt=Date.now()+this.api.offset;this.save();}
    await this.updateIncome();if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;this.save();throw new DemoError('Session goal already reached');}
    if(epoch!==this.stopEpoch)return;
    this.auto=true;this.retryAt=0;this.retryAttempt=0;this.block='';this.event(this.newRules?'Auto enabled · USDⓈ-M Demo · $300 target margin · adaptive 1–10× · net profit floors $2 / $4 / $6 / $8 / $10 / +$5 · trim 25% once at -$3 · close trade at -$5 · $100 net session closes bot positions and stops entries':this.experimentActive()?'EXPERIMENT enabled · 50× · available USDT · no automatic exits on new positions until '+new Date(this.experimentUntil).toISOString():'Auto enabled · filtered signals · adaptive 3× / 5× / 8× cross · up to $100 margin per entry · $1,000 budget · $800 total margin cap');
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
      if(r.lossReduction?.status==='PENDING')await this.settleReduction(r);
      let order;
      try{order=await this.queryEntry(r);}catch(e){
        if(e.code===-2013&&!e.uncertain&&(r.observedOpen||r.entryStatus==='FILLED')&&!r.pendingClose&&Date.now()+this.api.offset-r.at>60000){r.closedAt=Date.now()+this.api.offset;continue;}
        throw e;
      }
      if(!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(order.status)||r.pendingClose||r.lossReduction?.status==='PENDING')
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
  async entryRead(path,params={},signed=true){
    if(!ENTRY_READ_PATHS.has(path))throw new DemoError('Invalid candidate read route');
    try{return await this.api.call('GET',path,params,signed);}
    catch(error){
      // Only a read performed before any entry dispatch may be skipped. Account,
      // position, reconciliation and protection calls deliberately do not use this.
      if(error instanceof DemoError&&(ENTRY_READ_TRANSIENT.has(error.code)||[400,404].includes(error.code)))error.candidateRead=path;
      throw error;
    }
  }
  async checkEntryAccounting(symbol){
    if(Date.now()-(this.entryAccountingReadyAt||0)<300000)return;
    if(Date.now()<(this.accountingRetryAt||0)){const error=new DemoError(this.accountingBlock||'Waiting to recheck Binance fee history',400);error.candidateRead='/fapi/v1/userTrades';throw error;}
    try{
      const rows=await this.entryRead('/fapi/v1/userTrades',{symbol,limit:1});
      if(!Array.isArray(rows)){const error=new DemoError('Binance fee history is unreadable; entry deferred',0);error.candidateRead='/fapi/v1/userTrades';throw error;}
      this.entryAccountingReadyAt=Date.now();this.accountingBlock='';this.accountingRetryAt=0;
    }catch(error){
      if([400,404].includes(error.code)){
        this.accountingBlock=error.backendUpdateRequired?'Update and restart the laptop connector: fee-history reads are not supported. No entry submitted.':'Binance fee-history read unavailable ('+error.code+'); no entry submitted. Checking again in 30 seconds.';
        this.accountingRetryAt=Date.now()+30000;error.message=this.accountingBlock;error.candidateRead='/fapi/v1/userTrades';
      }
      throw error;
    }
  }
  async trialLeverageCeiling(symbol){
    // A missing bracket route is not an order rejection. Validate a fallback
    // through leverage-setting responses, without ever placing a test order.
    if(Date.now()<(this.bracketUnavailableUntil||0))return 150;
    let data;
    try{data=await this.entryRead('/fapi/v1/leverageBracket',{symbol});}
    catch(error){
      if(error.uncertain||![400,404].includes(error.code))throw error;
      this.bracketUnavailableUntil=Date.now()+300000;
      this.event('Leverage bracket read unavailable ('+error.code+'). Checking leverage through Binance settings; Auto remains enabled.');return 150;
    }
    const row=Array.isArray(data)?data.find(x=>x.symbol===symbol):data,values=row?.brackets?.map(b=>Number(b.initialLeverage));
    if(row?.symbol!==symbol||!values?.length||values.some(v=>!Number.isInteger(v)||v<1||v>150)){
      const error=new DemoError('Invalid Binance leverage brackets; skipping this symbol',0);error.candidateRead='/fapi/v1/leverageBracket';throw error;
    }
    return Math.max(...values);
  }
  async enter(symbol,signal){
    const timing={symbol,startedAt:Date.now(),stages:[]};this.entryTiming=timing;
    const recordsBefore=this.state.records.length;
    try{return await this.enterChecked(symbol,signal);}catch(e){
      // Only skip pre-entry failures when no journaled/observed position can be at risk.
      if(this.state.records.length===recordsBefore&&!this.owned(symbol)&&!this.position(symbol)&&(e.candidateRead||(!e.uncertain&&ENTRY_REJECTIONS.has(e.code)))){
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
    const trial=this.trialActive()&&signal.oneHourTrial===this.state.oneHourTrial.id;
    if(signal.oneHourTrial&&!trial)return skip('One-hour experiment expired or changed; rechecking normal signals');
    if(!this.auto||this.state.goalStopAt||(!this.newRules&&this.state.goal&&!this.experimentActive())||this.owned(symbol))return skip('Auto paused, session goal reached, or already owned');
    if(!signal.qualityConfirmed||![3,5,8].includes(signal.leverage)||!Number.isFinite(signal.stopDistance)||signal.stopDistance<=0)return skip('Signal validation failed');
    if(this.newRules&&!(signal.strength>=1))return skip('Candle momentum agreement is missing');
    const experimental=this.experimentActive()&&signal.experimental===true;
    if(signal.experimental&&!experimental)return skip('Experiment expired; waiting for a normal signal');
    const lossLimit=trial?null:this.newRules?5:signal.exitPolicy==='manual-profit-60s-loss'?5:9;
    if(!trial&&this.state.records.some(r=>r.symbol===symbol&&((!this.newRules&&r.signalClose===signal.close)||Date.now()-(r.closedAt||r.at)<(this.newRules&&r.closedAt?600000:60000))))return skip('Already traded this candle or re-entry cooldown (10 minutes after close)');
    progress('Checking Binance balance, positions and open orders');
    await this.refresh({inventory:!this.newRules,valuation:false});
    if(this.newRules&&await this.enforceSessionGoal())return skip('$100 net session target reached');
    if(!this.auto||epoch!==this.stopEpoch||this.position(symbol)||(!this.newRules&&(this.orders.some(o=>o.symbol===symbol)||this.algos.some(o=>o.symbol===symbol))))return skip('Auto changed or existing position/order');
    // Candidate-specific reads prevent stale cached inventories admitting duplicates.
    progress('Checking this symbol for existing orders');
    const inventories=await Promise.all(['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'].map(path=>this.entryRead(path,{symbol})));
    for(const existing of inventories){if(!Array.isArray(existing))throw new DemoError('Order check incomplete');if(existing.length)return skip('Existing Binance order on this symbol');}
    if(Date.now()-this.metaAt>900000)throw new DemoError('Exchange filters expired. Reconnect to refresh.');
    const m=this.meta.get(symbol),lot=m.filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=m.filters.find(f=>f.filterType==='LOT_SIZE'),priceFilter=m.filters.find(f=>f.filterType==='PRICE_FILTER');
    if(!lot||!normal||!priceFilter||!m.orderTypes.includes('MARKET'))return skip('Market-order filters unavailable');
    let momentum;
    if(this.newRules){
      progress('Rechecking current 1m momentum before entry');
      try{momentum=entryMomentum(await this.entryRead('/fapi/v1/klines',{symbol,interval:'1m',limit:30},false),signal.side,Date.now()+this.api.offset);}
      catch(error){if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return skip('1m entry check unavailable; scanning continues: '+error.message);}
      if(momentum.reason)return skip(momentum.reason+'; scanning continues');
    }
    progress('Checking current entry price');
    const mark=await this.entryRead('/fapi/v1/premiumIndex',{symbol},false);const price=number(mark.markPrice);
    if(Math.abs(Date.now()+this.api.offset-number(mark.time))>15000||(!this.newRules&&Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000))return skip('Signal or mark price became stale');
    if(!this.newRules&&!experimental){const reason=entryPriceReason(price,signal);if(reason)return skip(reason);}
    progress('Checking commission and position size');
    const feeInfo=await this.entryRead('/fapi/v1/commissionRate',{symbol}),fee=number(feeInfo.takerCommissionRate);
    if(fee<0||fee>.01)throw new DemoError('Unsupported commission rate');
    let candidateChecks;
    if(this.newRules){
      const selection=selectEntryCandidate(signal,{price,fee,now:Date.now()+this.api.offset,...(trial?{intervals:[1,3,5,15,30,60,120,240]}:{}),traded:candidate=>this.state.records.some(r=>r.symbol===symbol&&r.signalClose===candidate.close)});
      candidateChecks=selection.checks;const row=this.scanned.find(s=>s.symbol===symbol);if(row)row.entryCandidates=candidateChecks;
      if(!selection.signal)return skip('No entry-ready timeframe: '+candidateChecks.map(c=>c.minutes+'m '+c.reason).join(' | '));
      signal=selection.signal;progress('Selected '+signal.intervalMs/60000+'m '+(signal.setupType||'breakout')+' after price and commission checks');
    }
    if(this.newRules){progress('Checking fee history before entry');await this.checkEntryAccounting(symbol);}
    const usdt=this.account.assets.find(a=>a.asset==='USDT');if(!usdt)throw new DemoError('No USDT available for USDT cross-margin trades');
    if(this.state.budgetWalletBaseline===undefined){this.state.budgetWalletBaseline=number(usdt.walletBalance);this.save();}
    const capital=this.budgetStatus();
    const preferredLeverage=this.entryLeverage(signal);
    const step=number(lot.stepSize)>0?lot.stepSize:normal.stepSize;
    const minNotional=number(m.filters.find(f=>f.filterType==='MIN_NOTIONAL')?.notional||m.filters.find(f=>f.filterType==='NOTIONAL')?.minNotional||0);
    const available=number(usdt.availableBalance),marginRoom=Math.max(0,5000-capital.reserved);
    if(trial&&(!(available>0)||!(marginRoom>0)))return skip('Waiting for available margin; experiment scanning continues');
    const minimumPlan=(candidate,entryPrice=price,cap=Infinity)=>{
      if(trial){
        const budget=Math.min(300,marginRoom,available/(1+2*candidate*fee));
        if(!(budget>0))throw new DemoError('No free margin for experiment entry');
        const quantity=rounded(Math.min(budget*candidate/entryPrice,cap/entryPrice,number(lot.maxQty),number(normal.maxQty)),step);
        const qty=number(quantity);return {quantity,qty,notional:qty*entryPrice};
      }
      const quantity=rounded(Math.max(ENTRY_MARGIN*candidate/entryPrice,minNotional/entryPrice,number(lot.minQty),number(normal.minQty)),step,true);
      const qty=number(quantity),notional=qty*entryPrice;
      return {quantity,qty,notional};
    };
    if(this.newRules&&!trial&&(available<ENTRY_MARGIN||marginRoom<ENTRY_MARGIN))return skip('Waiting for at least $300 free margin plus fees; scanning continues');
    if(this.newRules&&!trial&&signal.intervalMs===60000&&2*momentum.atr<=3*(2*price*fee))return skip('Recent 1m movement is too small relative to round-trip fees; scanning continues');
    const trialCeiling=trial?await this.trialLeverageCeiling(symbol):null;
    const leverageCeiling=trial?trialCeiling:this.newRules?signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset):preferredLeverage;
    const adaptive=this.newRules&&!trial?adaptiveLeveragePlan({price,atr:momentum.atr,fee,lossLimit:ENTRY_VOLATILITY_ALLOWANCE,side:signal.side,tick:priceFilter.tickSize,plan:minimumPlan,maxLeverage:leverageCeiling,requireStop:false}):null;
    if(this.newRules&&!trial&&!adaptive)return skip('$300 margin exceeds the entry volatility and fee allowance, even at 1×; scanning continues');
    const requestedLeverage=trial?trialCeiling:this.newRules?adaptive.leverage:preferredLeverage;
    progress('Configuring '+requestedLeverage+'× '+(trial?'maximum supported experiment leverage':'based on recent volatility and fees'));
    try{await this.api.call('POST','/fapi/v1/marginType',{symbol,marginType:'CROSSED'});}catch(e){if(e.code!==-4046)throw e;}
    let leverage,selectedLeverage,minimumSize;
    if(this.newRules){
      // Preserve $300 margin; lower the adaptive choice for exchange limits.
      const tryLeverage=async candidate=>{
        if(!this.auto||epoch!==this.stopEpoch)return false;
        try{
          const response=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:candidate});
          if(number(response.leverage)!==candidate||(response.symbol!==undefined&&response.symbol!==symbol))throw new DemoError('Selected leverage not accepted for this symbol');
          if(trial&&!(number(response.maxNotionalValue)>0))return false;
          const size=minimumPlan(candidate,price,trial?number(response.maxNotionalValue):Infinity);
          if(trial&&(size.qty<Math.max(number(lot.minQty),number(normal.minQty))||size.notional<minNotional))return false;
          if(size.notional>number(response.maxNotionalValue))return false;
          leverage=response;selectedLeverage=candidate;minimumSize=size;return true;
        }catch(e){
          if(e.uncertain||![-4028,-1130,-4202,-4203,-4205,-4206,-4208,-4209,-4403].includes(e.code))throw e;
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
    if(!selectedLeverage)return skip(trial?'No supported leverage permits the minimum order with available margin; scanning continues':'No supported leverage permits $300 margin; scanning continues');
    let quantity,qty,notional;
    if(this.newRules){
      ({quantity,qty,notional}=minimumSize);
      const margin=notional/selectedLeverage,costs=notional*fee*2;
      if((!trial&&margin+1e-8<ENTRY_MARGIN)||margin>marginRoom+1e-8||margin+costs>available+1e-8)return skip('Not enough room for $300 margin plus fees at the selected leverage; scanning continues');
      if(qty>number(lot.maxQty)||qty>number(normal.maxQty))return skip('$300 order exceeds Binance quantity limits; scanning continues');
      progress('Using '+selectedLeverage+'× with $'+margin.toFixed(2)+' estimated margin'+(trial?' · experiment; fees can trigger immediate loss closure':''));
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
      progress('Checking current spread, mark price and entry exposure');
      try{
        const [quote,currentMark]=await Promise.all([this.entryRead('/fapi/v1/ticker/bookTicker',{symbol},false),this.entryRead('/fapi/v1/premiumIndex',{symbol},false)]);
        const quotedPrice=number(signal.side==='BUY'?quote.askPrice:quote.bidPrice);
        if(quotedPrice<=0)return skip('Invalid entry quote; scanning continues');
        ({quantity,qty,notional}=minimumPlan(selectedLeverage,quotedPrice,trial?number(leverage.maxNotionalValue):Infinity));
        quoteEvidence=entryQuoteCheck(quote,currentMark,{symbol,side:signal.side,qty,fee,lossLimit,tick:priceFilter.tickSize,now:Date.now()+this.api.offset});
        if(quoteEvidence.reason)return skip(quoteEvidence.reason+'; scanning continues');
        quoteEvidence.estimatedLossAtOneAtr=Math.max(0,-quoteEvidence.estimatedImmediateExitNet,-quoteEvidence.estimatedMarkNet)+qty*(momentum?.atr||0)*(1+fee);
        if(!trial&&quoteEvidence.estimatedLossAtOneAtr>ENTRY_VOLATILITY_ALLOWANCE+1e-8)return skip('Fresh spread, mark movement and one recent 1m ATR exceed the entry sizing allowance; scanning continues');
        const quoteReason=entryPriceReason(quotedPrice,signal,{tolerant:true});if(quoteReason)return skip('Executable quote: '+quoteReason+'; scanning continues');
        if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional||qty>number(lot.maxQty)||qty>number(normal.maxQty)||notional>number(leverage.maxNotionalValue))return skip('Fresh quote size exceeds Binance order limits; scanning continues');
        const units=qty/number(normal.stepSize);if(!Number.isFinite(units)||Math.abs(units-Math.round(units))>1e-7)return skip('Quantity is not valid for Binance lot step; scanning continues');
        const margin=notional/selectedLeverage;
        if(margin>marginRoom+1e-8||margin+quoteEvidence.estimatedRoundTripFees>available+1e-8)return skip('Fresh quote needs more margin plus fees than available; scanning continues');
      }catch(error){if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return skip('Entry quote check unavailable; scanning continues: '+error.message);}
    }
    if(!this.auto||epoch!==this.stopEpoch||this.controlPending||this.shouldScan?.()===false)return skip(this.controlPending?'Manual action queued before entry dispatch':'Auto stopped before entry dispatch');
    if(this.newRules&&!trial&&selectedLeverage>signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset))return skip('Market context became stale during checks; rechecking before higher leverage');
    if(this.newRules&&(Date.now()+this.api.offset-momentum.closedAt>75000||Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000))return skip('Entry confirmation became stale during checks; rechecking next scan');
    if(trial&&(!this.trialActive()||signal.oneHourTrial!==this.state.oneHourTrial.id||Date.now()+this.api.offset-signal.close>(signal.intervalMs||60000)+15000))return skip('Experiment expired or candle became stale before entry dispatch');
    if(experimental&&!this.experimentActive())return skip('Experiment expired before order submission');
    if(this.entryLeverage(signal)!==preferredLeverage)return skip('50× window expired during checks; next scan uses adaptive leverage');
    const id='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
    const r={id,entryAppVersion:APP_VERSION,symbol,side:signal.side,quantity,fee,tick:priceFilter.tickSize,at:Date.now()+this.api.offset,signalClose:signal.close,signal,rulesVersion:this.newRules?8:1,experimentUntil:experimental?this.experimentUntil:null,leverage:selectedLeverage,lossLimit,takeProfit:null,exitPolicy:this.newRules?'net-trailing':signal.exitPolicy,exits:[],protected:false,exitsReady:false};
    if(trial){r.oneHourTrial={...this.state.oneHourTrial};r.rulesVersion=9;r.exitPolicy='trial-net-trailing';r.lossLimit=1;}
    r.estimatedEntryMargin=notional/selectedLeverage;
    if(this.newRules)r.entryEvidence={oneMinute:momentum,candidateChecks,...quoteEvidence,requestedLeverage,selectedLeverage,adaptiveSizing:{...adaptive,leverageCeiling},marketContext:this.marketContext||null,marketSource:signal.marketSource||{type:'full-market'}};
    r.sizingNote='Entry margin ≈ $'+(notional/selectedLeverage).toFixed(2)+' · estimated round-trip commission $'+(notional*fee*2).toFixed(2)+' · $300 target margin; adaptive leverage up to 10× based on candle agreement, BTC market context, 1m volatility, fees and exchange limits; trailing net profit from $2; trim 25% at -$3; close at -$5; market fill margin may differ';
    if(trial)r.sizingNote='One-hour experiment · margin ≈ $'+r.estimatedEntryMargin.toFixed(2)+' · '+selectedLeverage+'× · any negative estimated total net closes immediately when detected; fees alone can cause closure · net pullback floors $2 / $4 / $8 / $10 / +$5';
    this.state.records.push(r);this.save(); // Journal before dispatch; never duplicate an uncertain entry.
    progress('Submitting demo order');
    try{const order=await this.sendOnce('/fapi/v1/order',{symbol,side:r.side,positionSide:'BOTH',type:'MARKET',quantity,newClientOrderId:id,newOrderRespType:'RESULT'},()=>this.queryEntry(r));r.orderId=order.orderId;r.entryStatus=order.status;this.save();
      // Install protection directly from a confirmed fill before slower balance reads.
      if(order.status==='FILLED'&&Number(order.avgPrice)>0&&Number(order.executedQty)>0){
        const filled={entryPrice:order.avgPrice,positionAmt:r.side==='BUY'?order.executedQty:String(-Number(order.executedQty)),markPrice:order.avgPrice};r.entry=Number(order.avgPrice);r.filledQty=Number(order.executedQty);this.save();
        try{
          if(trial){await this.reconcileTrialExits(r,filled);}
          else if(this.newRules){await this.ensureExit(r,filled,'sl5',-5);r.exitsReady=!r.closedAt;r.protected=!r.closedAt;}
          else if(!this.exitsSuspended(r)){await this.ensureExit(r,filled,r.rulesVersion===5?'sl20':r.rulesVersion===4?'sl4m':r.rulesVersion===3?'sl8':r.rulesVersion===2?'sl4':'sl',-(r.lossLimit??9));if(!r.closedAt&&!['manual-profit','manual-profit-60s-loss'].includes(r.exitPolicy))await this.ensureExit(r,filled,'tp',40);r.protected=!r.closedAt;}
          this.save();
        }
        catch(e){r.protectionError={at:Date.now()+this.api.offset,code:e.code||0,message:e.message};this.save();this.pause('Protection failed immediately after fill. '+e.message);if(!r.closedAt)await this.close(symbol,'Protection failure');throw e;}
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
    await this.refresh();await this.reconcile();this.entryOutcome=r.closedAt?'Entry closed during exit checks':'Entry submitted; status '+r.entryStatus;this.event(symbol+(this.exitsSuspended(r)?' demo entry submitted; automatic exits SUSPENDED until experiment expiry.':' demo entry submitted; confirmed fills and automatic exit policy shown below.'));
  }
  async cancelExits(r,keepId=null){
    for(const e of r.exits||[]){if(e.cancelled||e.id===keepId)continue;try{await this.api.call('DELETE','/fapi/v1/algoOrder',{clientAlgoId:e.id});e.cancelled=true;this.save();}catch(err){const found=await this.queryExit(e).catch(q=>{if([-2011,-2013].includes(q.code))return {algoStatus:'NOT_FOUND'};throw q;});if(['CANCELED','CANCELLED','FINISHED','EXPIRED','REJECTED','NOT_FOUND'].includes(found.algoStatus)){e.cancelled=true;this.save();}else throw err;}}
  }
  async ensureExit(r,p,kind,target,replace=false){
    let e=replace?null:r.exits.findLast(e=>e.kind===kind&&!e.cancelled);
    if(e){if(this.newRules&&e.confirmed&&Date.now()-(e.verifiedAt||0)<15000)return;const q=await this.queryExit(e);if(q.algoStatus==='NEW'){e.confirmed=true;e.verifiedAt=Date.now();return;}e.confirmed=false;if(['CANCELED','CANCELLED','EXPIRED','REJECTED'].includes(q.algoStatus))e.cancelled=true;this.save();throw new DemoError(r.symbol+' protective '+kind+' is '+q.algoStatus+'; checking position.');}
    const triggerPrice=exitPrice(number(p.entryPrice),Math.abs(number(p.positionAmt)),r.fee,target,r.side,r.tick);
    const takeProfit=kind==='tp'||kind==='tp20';
    const mark=number(p.markPrice);if(takeProfit?(r.side==='BUY'?mark>=+triggerPrice:mark<=+triggerPrice):(r.side==='BUY'?mark<=+triggerPrice:mark>=+triggerPrice)){await this.close(r.symbol,kind+' threshold reached');return;}
    const prior=r.exits.filter(x=>x.kind===kind).length;
    e={id:r.id+'_'+kind+(prior?'_'+prior:''),kind,triggerPrice,confirmed:false};r.exits.push(e);this.save();
    let result;try{result=await this.sendOnce('/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:r.symbol,side:r.side==='BUY'?'SELL':'BUY',positionSide:'BOTH',type:takeProfit?'TAKE_PROFIT_MARKET':'STOP_MARKET',closePosition:'true',triggerPrice,workingType:'MARK_PRICE',priceProtect:'false',clientAlgoId:e.id},()=>this.queryExit(e));}catch(error){if(!error.uncertain){e.cancelled=true;this.save();}throw error;}
    if(result.algoStatus!=='NEW')throw new DemoError('Protection was not confirmed NEW');
    e.confirmed=true;e.verifiedAt=Date.now();this.save();
  }
  async tradeAccounting(r,p,{force=false}={}){
    const now=Date.now()+this.api.offset,qty=Number(p.positionAmt),cached=r.tradeAccounting;
    if(!force&&cached&&cached.qty===qty&&cached.entryPrice===Number(p.entryPrice)&&cached.windowStart===this.state.startedAt&&now-cached.at<30000)return cached;
    if(!r.orderId)throw new DemoError('Confirmed entry ID required for after-fee accounting');
    let first=r.firstTradeId;
    if(!first){
      const entry=await this.api.call('GET','/fapi/v1/userTrades',{symbol:r.symbol,orderId:r.orderId,limit:1000});
      if(!Array.isArray(entry)||!entry.length||entry.some(t=>String(t.orderId)!==String(r.orderId)))throw new DemoError('Entry commissions are not available yet; profit exit deferred');
      first=entry.map(t=>BigInt(t.id)).reduce((a,b)=>a<b?a:b).toString();r.firstTradeId=first;this.save();
    }
    const rows=[],seen=new Set();let fromId=first,complete=false;
    for(let page=0;page<20;page++){
      const chunk=await this.api.call('GET','/fapi/v1/userTrades',{symbol:r.symbol,fromId,limit:1000});
      if(!Array.isArray(chunk))throw new DemoError('Invalid execution history');
      let largest=BigInt(fromId)-1n;
      for(const t of chunk){const id=BigInt(t.id);if(id<BigInt(fromId))throw new DemoError('Execution history pagination did not advance');if(seen.has(id.toString()))continue;seen.add(id.toString());rows.push(t);if(id>largest)largest=id;}
      if(chunk.length<1000){complete=true;break;}if(largest<BigInt(fromId))break;fromId=(largest+1n).toString();
    }
    if(!complete)throw new DemoError('Execution history incomplete; profit exit deferred');
    rows.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    if(!rows.length||String(rows[0].orderId)!==String(r.orderId))throw new DemoError('Entry fill missing from execution history');
    let balance=0,realized=0,commission=0,windowBooked=0,lastTradeAt=0;
    for(let i=0;i<rows.length;i++){
      const t=rows[i],q=number(t.qty),fee=number(t.commission),pnl=number(t.realizedPnl),time=number(t.time);
      if(t.symbol!==r.symbol||t.positionSide!=='BOTH'||!['BUY','SELL'].includes(t.side)||q<=0||fee<0||(fee!==0&&t.commissionAsset!=='USDT'))throw new DemoError('Unsupported fill or commission asset; after-fee accounting unavailable');
      balance+=q*(t.side==='BUY'?1:-1);realized+=pnl;commission+=fee;lastTradeAt=Math.max(lastTradeAt,time);
      if(time>=this.state.startedAt)windowBooked+=pnl-fee;
      if(i<rows.length-1&&(Math.abs(balance)<1e-10||(balance>0)!==(r.side==='BUY')))throw new DemoError('Position was replaced outside the bot; review Binance');
    }
    if(Math.abs(balance-qty)>Math.max(1e-8,Math.abs(qty)*1e-8))throw new DemoError('Execution history is settling or position quantity changed; awaiting matching fills');
    let funding=0,windowFunding=0;
    if(this.incomeWindowStart<=r.at&&now-(this.incomeWindowEnd||0)<5000){
      for(const row of this.income)if(row.symbol===r.symbol&&row.incomeType==='FUNDING_FEE'&&Number(row.time)>=r.at){funding+=number(row.income);if(Number(row.time)>=this.state.startedAt)windowFunding+=number(row.income);}
    }else{
      const fundingRows=await this.api.call('GET','/fapi/v1/income',{symbol:r.symbol,incomeType:'FUNDING_FEE',startTime:r.at,endTime:now,limit:1000});
      if(!Array.isArray(fundingRows)||fundingRows.length>=1000)throw new DemoError('Funding history incomplete');
      for(const row of fundingRows)if(row.symbol===r.symbol&&row.incomeType==='FUNDING_FEE'&&Number(row.time)>=r.at){if(row.asset!=='USDT')throw new DemoError('Unsupported funding asset');funding+=number(row.income);if(Number(row.time)>=this.state.startedAt)windowFunding+=number(row.income);}
    }
    const ledger={qty,entryPrice:Number(p.entryPrice),realized,commission,funding,bookedNet:realized-commission+funding,windowBooked:windowBooked+windowFunding,windowStart:this.state.startedAt,lastTradeAt,at:now};
    r.tradeAccounting=ledger;this.save();return ledger;
  }
  async closingEstimate(r,p,{forceAccounting=false}={}){
    const qty=Math.abs(Number(p.positionAmt)),entry=Number(p.entryPrice),fee=Number(r.fee),now=()=>Date.now()+this.api.offset;
    if(!(qty>0&&entry>0&&Number.isFinite(fee)&&fee>=0)||((Number(p.positionAmt)>0)!==(r.side==='BUY')))throw new DemoError('Invalid position or fee for closing estimate');
    const ledger=await this.tradeAccounting(r,p,{force:forceAccounting});
    const quote=await this.api.call('GET','/fapi/v1/ticker/bookTicker',{symbol:r.symbol},false);
    const bid=Number(quote.bidPrice),ask=Number(quote.askPrice),time=Number(quote.time);
    if(quote.symbol!==r.symbol||!(bid>0&&ask>=bid)||!Number.isFinite(time)||Math.abs(now()-time)>5000)throw new DemoError('Closing quote is invalid or stale');
    let price=r.side==='BUY'?bid:ask,source='best bid/ask';
    if(!(Number(r.side==='BUY'?quote.bidQty:quote.askQty)>=qty)){
      const depth=await this.api.call('GET','/fapi/v1/depth',{symbol:r.symbol,limit:20},false),stamp=Number(depth.T??depth.E);
      if(!Number.isFinite(stamp)||Math.abs(now()-stamp)>5000)throw new DemoError('Closing depth is stale');
      const levels=r.side==='BUY'?depth.bids:depth.asks;if(!Array.isArray(levels))throw new DemoError('Closing depth unavailable');
      let left=qty,notional=0,previous=r.side==='BUY'?Infinity:0;
      for(const level of levels){const px=Number(level[0]),size=Number(level[1]);
        if(!(px>0&&size>0)||(r.side==='BUY'?px>previous:px<previous))throw new DemoError('Invalid closing depth');
        const used=Math.min(left,size);notional+=used*px;left-=used;previous=px;if(left<=qty*1e-12)break;
      }
      if(left>qty*1e-12)throw new DemoError('Insufficient visible depth to estimate the entire close');
      price=notional/qty;source='20-level depth';
    }
    const closingFee=qty*price*fee,gross=(price-entry)*qty*(r.side==='BUY'?1:-1),net=Math.round((ledger.bookedNet+gross-closingFee)*1e8)/1e8;
    if(!Number.isFinite(net))throw new DemoError('Closing estimate unavailable');
    r.closingEstimate={net,gross,fees:ledger.commission+closingFee,paidCommission:ledger.commission,closingFee,realized:ledger.realized,funding:ledger.funding,price,quantity:qty,source,at:now()};r.netEstimate=net;r.estimateError=null;this.save();return net;
  }
  updateProfitTrail(r,net){
    r.trailPeak=Math.max(r.trailPeak??-Infinity,net);r.profitFloor=(r.oneHourTrial?trialProfitFloor:netProfitFloor)(r.trailPeak);this.save();
    return Number.isFinite(r.profitFloor)&&net<=r.profitFloor;
  }
  async ensureLossStop(r,p){
    const qty=Math.abs(Number(p.positionAmt)),entry=Number(p.entryPrice),ledger=r.tradeAccounting,limit=r.oneHourTrial?1:5,kind=r.oneHourTrial?'sl1':'sl5';
    let target=-limit-(ledger?.bookedNet??(-qty*entry*r.fee))-qty*entry*r.fee;
    const sign=r.side==='BUY'?1:-1,raw=(target/qty+entry*(sign+r.fee))/(sign-r.fee),minimum=Math.max(Number(r.tick),Number(this.meta.get(r.symbol)?.filters?.find(f=>f.filterType==='PRICE_FILTER')?.minPrice)||0);
    if(r.side==='BUY'&&raw<minimum)target=(minimum-entry)*qty-qty*(entry+minimum)*r.fee;
    // exitPrice includes an opening fee; remove that duplicated deduction from the requested target because bookedNet includes paid commissions.
    const trigger=exitPrice(entry,qty,r.fee,target,r.side,r.tick),existing=(r.exits||[]).findLast(e=>e.kind===kind&&!e.cancelled);
    await this.ensureExit(r,p,kind,target,!!existing&&existing.triggerPrice!==trigger);
    if(r.closedAt||r.pendingClose)return;
    const keep=r.exits.findLast(e=>e.kind===kind&&!e.cancelled);if(!keep?.confirmed)throw new DemoError('Replacement loss stop is unconfirmed');await this.cancelExits(r,keep.id);r.protected=true;r.exitsReady=true;this.save();
  }

  async settleReduction(r,order=null,cancelPending=false){
    const reduction=r.lossReduction;if(reduction?.status!=='PENDING')return;
    order??=await this.api.call('GET','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:reduction.id});
    if(cancelPending&&['NEW','PARTIALLY_FILLED'].includes(order.status)){
      await this.api.call('DELETE','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:reduction.id});
      order=await this.api.call('GET','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:reduction.id});
    }
    if(!['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(order.status))throw new DemoError('25% reduction awaiting confirmation',0,true);
    const executed=Number(order.executedQty??0);
    if(!Number.isFinite(executed)||executed<0||(order.status==='FILLED'&&executed===0)||executed>Number(reduction.quantity)+1e-8)throw new DemoError('Invalid reduction fill quantity',0,true);
    reduction.status=executed>0?'DONE':order.status;reduction.exchangeStatus=order.status;reduction.executedQty=executed;reduction.finishedAt=Date.now()+this.api.offset;this.save();
    await this.refresh();const p=this.position(r.symbol);r.filledQty=p?Math.abs(Number(p.positionAmt)):0;
    r.netEstimate=null;r.closingEstimate=null;r.tradeAccounting=null;this.save();
    if(this.newRules&&p&&!cancelPending){await this.tradeAccounting(r,p);await this.ensureLossStop(r,p);}
    this.event(r.symbol+' one-time loss reduction: '+executed+' filled of '+reduction.quantity+' requested; remaining exposure updated.');
  }
  async reduceLosingPosition(r){
    if(r.lossReduction){await this.settleReduction(r);return;}
    const list=await this.api.call('GET','/fapi/v3/positionRisk',{symbol:r.symbol});
    if(!Array.isArray(list))throw new DemoError('Invalid position response');
    const p=list.find(x=>x.symbol===r.symbol&&x.positionSide==='BOTH'&&Number(x.positionAmt)!==0);if(!p)return;
    if((Number(p.positionAmt)>0)!==(r.side==='BUY'))throw new DemoError('Position direction changed outside bot');
    const net=await this.closingEstimate(r,p);if(net<=-5){await this.close(r.symbol,'$5 net trade loss');return;}if(net>-3)return;
    const filters=this.meta.get(r.symbol)?.filters||[],market=filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=filters.find(f=>f.filterType==='LOT_SIZE');
    if(!market||!normal)throw new DemoError('Quantity limits unavailable for 25% reduction');
    const step=Number(market.stepSize)>0?market.stepSize:normal.stepSize,qty=Math.abs(Number(p.positionAmt));
    if(!(Number(step)>0))throw new DemoError('Invalid reduction quantity step');
    const quantity=rounded(qty*.25,step),amount=Number(quantity);
    const normalUnits=amount/Number(normal.stepSize);
    if(!(amount>0&&amount<=qty*.25+1e-10&&amount>=Math.max(Number(market.minQty),Number(normal.minQty))&&amount<=Math.min(Number(market.maxQty),Number(normal.maxQty)))||!Number.isFinite(normalUnits)||Math.abs(normalUnits-Math.round(normalUnits))>1e-7){
      r.lossReduction={status:'SKIPPED',at:Date.now()+this.api.offset,reason:'25% is outside Binance quantity limits; no larger reduction sent'};this.save();this.event(r.symbol+' '+r.lossReduction.reason);return;
    }
    r.lossReduction={id:'bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,22)+'_r',status:'PENDING',quantity,positionQty:qty,netBefore:r.netEstimate,at:Date.now()+this.api.offset};this.save();
    let order;
    try{order=await this.sendOnce('/fapi/v1/order',{symbol:r.symbol,side:r.side==='BUY'?'SELL':'BUY',positionSide:'BOTH',type:'MARKET',quantity,reduceOnly:'true',newClientOrderId:r.lossReduction.id,newOrderRespType:'RESULT'},()=>this.api.call('GET','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.lossReduction.id}));}
    catch(error){
      if(error.uncertain)throw error;
      r.lossReduction.status='REJECTED';r.lossReduction.reason=error.message;r.lossReduction.finishedAt=Date.now()+this.api.offset;this.save();
      this.event(r.symbol+' 25% reduction rejected; not repeated: '+error.message);if(ACCOUNT_BLOCKS.has(error.code)||[418,429].includes(error.code))throw error;return;
    }
    await this.settleReduction(r,order);
  }
  async reconcileTrialExits(r,p){
    try{
      const net=await this.closingEstimate(r,p);
      if(net<0){await this.close(r.symbol,'Experiment negative net',{trialExit:true});if(r.closedAt||r.pendingClose)return;}
      await this.ensureLossStop(r,p);if(r.closedAt)return;
      if(this.updateProfitTrail(r,r.netEstimate))await this.close(r.symbol,'Experiment profit pullback',{trialExit:true});
    }catch(error){
      r.estimateError=error.message;r.netEstimate=null;r.closingEstimate=null;this.save();
      if(!r.closedAt&&!r.pendingClose&&!r.exits.some(e=>e.kind==='sl1'&&e.confirmed&&!e.cancelled))await this.ensureLossStop(r,p);
      if(error.uncertain||r.pendingClose||ACCOUNT_BLOCKS.has(error.code)||[418,429].includes(error.code))throw error;
    }
  }
  async reconcileCurrentExits(r,p){
    if(r.rulesVersion!==8){r.rulesVersion=8;r.trailPeak=null;r.profitFloor=null;r.lossLimit=5;r.takeProfit=null;r.exitPolicy='net-trailing';r.experimentUntil=null;r.lossSince=null;r.tradeAccounting=null;this.save();}
    r.lossSince=null;
    r.sizingNote='Recorded entry margin ≈ $'+Number(r.estimatedEntryMargin||0).toFixed(2)+' · '+r.leverage+'× · after-fee trailing floors $2 / $4 / $6 / $8 / $10 / +$5 · reduce 25% once at -$3; close remainder at -$5 total trade net';
    let estimateReady=false;
    try{
      const net=await this.closingEstimate(r,p);estimateReady=true;
      if(net<=-5){await this.close(r.symbol,'$5 net trade loss');return;}
      await this.ensureLossStop(r,p);if(r.closedAt)return;
      if(net<=-3&&!r.lossReduction){await this.reduceLosingPosition(r);return;}
      const pullback=this.updateProfitTrail(r,net);
      if(pullback)await this.close(r.symbol,'Net profit trailing pullback',{trailing:true});
    }catch(error){
      r.estimateError=error.message;r.netEstimate=null;r.closingEstimate=null;this.save();
      // Keep a fee-estimated exchange backup if accounting is temporarily unavailable.
      if(!r.closedAt&&!r.pendingClose&&!r.exits?.some(e=>e.kind==='sl5'&&e.confirmed&&!e.cancelled)){if(estimateReady){this.pause('Loss stop requires reconciliation on '+r.symbol);throw error;}await this.ensureLossStop(r,p);}
      if(error.uncertain||r.pendingClose||r.lossReduction?.status==='PENDING'||ACCOUNT_BLOCKS.has(error.code)||[418,429].includes(error.code))throw error;
    }
  }
  async close(symbol,reason='Manual close',options={}){
    const r=this.owned(symbol);if(!r)throw new DemoError('This position is not owned by this bot. Manage it in Binance Demo.');
    if(r.lossReduction?.status==='PENDING')await this.settleReduction(r,null,true);
    if(r.pendingClose){const order=await this.api.call('GET','/fapi/v1/order',{symbol,origClientOrderId:r.pendingClose});if(!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(order.status))throw new DemoError('Close order still pending');r.pendingClose=null;this.save();await this.refresh();}
    const list=await this.api.call('GET','/fapi/v3/positionRisk',{symbol});if(!Array.isArray(list))throw new DemoError('Invalid position response');
    const p=list.find(x=>x.symbol===symbol&&x.positionSide==='BOTH'&&number(x.positionAmt)!==0);
    if(!p){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();return;}
    if((number(p.positionAmt)>0)!==(r.side==='BUY'))throw new DemoError('Position direction changed outside bot. Inspect Binance.');
    if(r.oneHourTrial&&(options.trialExit||['Experiment negative net','Experiment profit pullback'].includes(reason))){
      const net=await this.closingEstimate(r,p,{forceAccounting:true});
      if(net<0)reason='Experiment negative net';
      else if(reason!=='Experiment profit pullback'||!this.updateProfitTrail(r,net)||net<2)return false;
    }else if(options.trailing||reason==='Net profit trailing pullback'){
      const net=await this.closingEstimate(r,p,{forceAccounting:true});
      if(net<=-5)reason='$5 net trade loss';
      else if(!this.updateProfitTrail(r,net)||net<2)return false;
    }else if((options.positiveNet||reason==='Positive estimated closing P&L')&&!((await this.closingEstimate(r,p,{forceAccounting:true}))>=2))return false;
    r.pendingClose='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,22)+'_c';r.closeReason=reason;this.save();
    let order;try{order=await this.sendOnce('/fapi/v1/order',{symbol,side:number(p.positionAmt)>0?'SELL':'BUY',positionSide:'BOTH',type:'MARKET',quantity:String(Math.abs(number(p.positionAmt))),reduceOnly:'true',newClientOrderId:r.pendingClose,newOrderRespType:'RESULT'},()=>this.api.call('GET','/fapi/v1/order',{symbol,origClientOrderId:r.pendingClose}));}
    catch(error){if(!error.uncertain){r.pendingClose=null;this.save();}throw error;}
    if(order.status==='FILLED'){r.pendingClose=null;this.save();}else throw new DemoError('Close order awaiting final status');
    await this.refresh();if(!this.position(symbol)){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();this.event(symbol+' closed · '+reason);}
  }
  async reconcile(){
    for(const r of this.active()){
      if(r.lossReduction?.status==='PENDING')await this.settleReduction(r);
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
      if(this.newRules){if(r.oneHourTrial)await this.reconcileTrialExits(r,p);else await this.reconcileCurrentExits(r,p);continue;}
      try{
        await this.ensureExit(r,p,r.rulesVersion===5?'sl20':r.rulesVersion===4?'sl4m':r.rulesVersion===3?'sl8':r.rulesVersion===2?'sl4':'sl',-(r.lossLimit??9));if(r.closedAt||r.pendingClose)continue;
        if(!['manual-profit','manual-profit-60s-loss'].includes(r.exitPolicy))await this.ensureExit(r,p,'tp',40);if(r.closedAt||r.pendingClose)continue;
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
    const ms=({'1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000})[interval];if(!ms)throw new DemoError('Unsupported scan timeframe');const now=Date.now()+(this.api.offset||0),bucket=Math.floor(now/ms),key=symbol+':'+interval+':'+limit;
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
    if(!this.connected||!this.tradingReady||!this.active().length||Date.now()-(this.positionAt||0)<this.exitPollMs())return;
    const positions=await this.api.call('GET','/fapi/v3/positionRisk');
    if(!Array.isArray(positions))throw new DemoError('Invalid position snapshot during scan');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected');}
    this.positions=positions;this.positionAt=Date.now();this.notify();
    await this.ensureIncomeFresh(5000);if(await this.enforceSessionGoal())return;await this.reconcile();
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
    if(this.trialActive())return this.trialCandidate(symbol,mover,epoch,controller);
    const startedAt=Date.now(),raw=await this.scanBars(symbol,'1m',150,controller),now=Date.now()+this.api.offset;
    const closed=raw.filter(b=>number(b[6])<now),candleClosedAt=Number(closed.at(-1)?.[6])||null,checks=[],candidates=[];
    if(closed.length<21)return {symbol,mover,signal:null,reason:'Not enough closed candle history',foundCandidate:false,intervalMs:60000,scanMs:Date.now()-startedAt,candleClosedAt,checks};
    let trend=null,foundCandidate=false;
    if(this.experimentActive()){
      const signal=experimentSignal(raw,now);
      return {symbol,mover,signal,reason:'Experiment: no fresh directional candle',foundCandidate:!!signal,intervalMs:60000,scanMs:Date.now()-startedAt,candleClosedAt,checks};
    }
    for(const minutes of [1,2,3,4,5,10,15,20,30,60]){
      if(!this.auto||epoch!==this.stopEpoch||controller?.signal.aborted)break;
      if(minutes>5&&!trend)trend=await this.scanTrendBars(symbol,controller);
      const at=Date.now()+this.api.offset,bars=minutes===1?raw:minutes<=5?aggregateMinutes(raw,at,minutes):aggregateFiveMinuteBars(trend,at,minutes);
      const candidate=breakout(bars,at,minutes*60000);let reason='No closed breakout',qualified=null;
      if(candidate)foundCandidate=true;
      if(candidate||this.newRules){
        if(!trend)trend=await this.scanTrendBars(symbol,controller);
        if(candidate)qualified=qualifySetup(candidate,bars,trend,Date.now()+this.api.offset,r=>reason=r,300000);
        if(!qualified&&this.newRules)qualified=momentumSetup(bars,trend,Date.now()+this.api.offset,minutes*60000,r=>reason=r);
      }
      if(qualified&&mover&&qualified.side!==mover.side){reason='Mover priority requires '+mover.side+'; opposite candle signal skipped';qualified=null;}
      checks.push({minutes,side:qualified?.side||'WAIT',setupType:qualified?.setupType||'breakout',reason:qualified?'Candle setup qualified':reason});
      if(qualified){
        foundCandidate=true;candidates.push({...qualified,exitPolicy:this.newRules?'manual-profit':'manual-profit-60s-loss',intervalMs:minutes*60000,marketSource:mover?{type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change}:{type:'full-market'}});
        if(!this.newRules)break;
      }
    }
    const first=candidates[0],signal=first?{...first,alternatives:candidates.slice(1).filter(s=>s.side===first.side)}:null;
    const reason=checks.slice(0,3).map(c=>c.minutes+'m: '+c.reason).join(' | ')||'No qualifying setup';
    return {symbol,mover,signal,reason,foundCandidate,intervalMs:signal?.intervalMs||60000,scanMs:Date.now()-startedAt,candleClosedAt,checks};
  }
  async trialCandidate(symbol,mover,epoch,controller){
    const startedAt=Date.now(),trialId=this.state.oneHourTrial.id,checks=[],candidates=[];
    const trend=await this.scanTrendBars(symbol,controller);
    for(const [interval,minutes] of [['1m',1],['3m',3],['5m',5],['15m',15],['30m',30],['1h',60],['2h',120],['4h',240]]){
      if(!this.auto||epoch!==this.stopEpoch||!this.trialActive()||this.state.oneHourTrial.id!==trialId||controller?.signal.aborted)break;
      const raw=interval==='5m'?trend:await this.scanBars(symbol,interval,60,controller),now=Date.now()+this.api.offset,ms=minutes*60000;
      let reason='No confirmed setup',signal=momentumSetup(raw,trend,now,ms,r=>reason=r);
      if(!signal){const candidate=breakout(raw,now,ms);if(candidate)signal=qualifySetup(candidate,raw,trend,now,r=>reason=r,300000);}
      if(signal&&mover&&signal.side!==mover.side){reason='Mover direction and candle setup disagree';signal=null;}
      checks.push({minutes,side:signal?.side||'WAIT',reason:signal?'Momentum/breakout setup confirmed':reason});
      if(signal)candidates.push({...signal,intervalMs:ms,oneHourTrial:trialId,marketSource:mover?{type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change}:{type:'full-market'}});
    }
    const first=candidates[0],signal=first?{...first,alternatives:candidates.slice(1).filter(s=>s.side===first.side)}:null;
    return {symbol,mover,signal,foundCandidate:!!signal,intervalMs:signal?.intervalMs||60000,reason:checks.slice(0,3).map(c=>c.minutes+'m: '+c.reason).join(' | ')||'Experiment hour ended',scanMs:Date.now()-startedAt,candleClosedAt:signal?.close||null,checks};
  }
  async scan(){
    if(!this.auto||!this.symbols.length||this.shouldScan?.()===false)return;
    const epoch=this.stopEpoch;this.lastScan=Date.now();const startedAt=Date.now();
    await this.refreshMovers();if(!this.trialActive())await this.refreshMarketContext();
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
        const {mover,signal,reason,foundCandidate,intervalMs,scanMs,candleClosedAt,checks}=value;
        if(error)errors++;
        if(foundCandidate)this.rechecks.set(symbol,{seen:Date.now(),checked:Date.now()});else if(this.rechecks.has(symbol))this.rechecks.get(symbol).checked=Date.now();
        this.scanChecked=(this.scanChecked||0)+1;completed++;
        this.scanStats={startedAt,concurrency:3,planned:batch.length,completed,dataErrors:errors,elapsedMs:Date.now()-startedAt};
        this.scanned=this.scanned.filter(s=>s.symbol!==symbol);
        const row={symbol,source:mover?(mover.side==='BUY'?'Gainer ':'Loser ')+mover.change.toFixed(2)+'%':'Full-market / recheck',phase:error?'Data error':signal?'Entry checks':'Signal rules',reason:signal?'Confirmed '+(intervalMs/60000)+'m '+(signal.setupType||'breakout')+'; checking entry':reason,setupType:signal?.setupType||'breakout',side:signal?.side||'WAIT',strength:signal?.strength,leverage:signal&&!this.newRules?this.entryLeverage(signal):undefined,at:Date.now(),scanMs,candleClosedAt,checks};
        this.scanned.unshift(row);this.scanned=this.scanned.slice(0,30);this.notify();
        if(signal&&this.auto&&epoch===this.stopEpoch&&!this.controlPending){
          try{
            await this.ensureIncomeFresh();if(this.newRules&&await this.enforceSessionGoal())return;
            if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=100){this.state.goal=true;row.reason='Session goal reached; new entries paused';this.pause('Session goal reached');this.save();return;}
            await this.enter(symbol,signal);row.reason=this.entryOutcome;
            row.entryMs=this.entryTiming?.totalMs;row.phase=this.state.records.some(r=>r.symbol===symbol&&r.at>=row.at+(this.api.offset||0)&&!r.rejected)?'Order submitted':'Entry skipped';
          }catch(error){row.reason='Entry failed: '+error.message;row.phase='Entry error';throw error;}
          finally{this.recordScanResult(row);this.notify();}
        }else this.recordScanResult(row);
      }
    }finally{
      controller.abort();if(this.scanController===controller)this.scanController=null;
      this.scanStats={startedAt,finishedAt:Date.now(),concurrency:3,planned:batch.length,completed,dataErrors:errors,elapsedMs:Date.now()-startedAt};this.notify();
    }
  }
  async reviewContinuation(){
    // Advisory only; risk reconciliation always runs first. Review one position per tick.
    const r=this.active().filter(r=>!this.exitsSuspended(r)&&['manual-profit','manual-profit-60s-loss'].includes(r.exitPolicy)&&r.netEstimate>0&&Date.now()-(r.reviewAt||0)>=30000).sort((a,b)=>(a.reviewAt||0)-(b.reviewAt||0))[0];
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
  scheduleReadRecovery(error){
    if(!this.auto||error.requestMethod!=='GET'||error.uncertain||!(ENTRY_READ_TRANSIENT.has(error.code)||[418,429,-1003,-1015].includes(error.code)))return false;
    if(this.active().some(r=>r.pendingClose||r.lossReduction?.status==='PENDING'||!r.entryStatus||!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(r.entryStatus)))return false;
    const limited=[418,429,-1003,-1015].includes(error.code);
    const delay=limited?60000:Math.min(60000,5000*2**Math.min(this.retryAttempt||0,4));
    this.retryAttempt=(this.retryAttempt||0)+1;this.retryAt=Math.max(Date.now()+delay,this.api.blockUntil||0);
    this.block='Temporary read failure: '+error.message+' Auto will recheck connection and positions before resuming entries.';
    this.event(this.block);return true;
  }
  async tick(){
    if(!this.connected||this.busy||this.controlPending)return;
    this.expireTrial();if(this.retryAt>Date.now()){this.notify();return;}this.busy=true;
    try{
      this.expireTrial();this.syncDaily();
      if(!this.tradingReady){await this.refreshBalance();return;}
      if(Date.now()-(this.lastFullCheck||0)>=this.exitPollMs()||this.state.dayOpenPnl===null){await this.refresh();this.lastFullCheck=Date.now();}
      if(this.newRules){await this.ensureIncomeFresh(5000);if(await this.enforceSessionGoal()){await this.updateIncome();return;}}
      await this.reconcile();
      if(this.newRules){await this.ensureIncomeFresh(5000);if(await this.enforceSessionGoal()){await this.updateIncome();return;}}
      else if(Date.now()-this.lastIncome>15000)await this.updateIncome();
      if(this.auto&&Date.now()-this.metaAt>600000){const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');for(const symbol of [...this.meta.keys()]){const m=info.symbols.find(x=>x.symbol===symbol&&x.status==='TRADING');if(m)this.meta.set(symbol,m);else this.meta.delete(symbol);}this.symbols=[...this.meta.keys()].sort();this.metaAt=Date.now();}
      if(!this.newRules&&!this.experimentActive()&&this.state.startedAt&&this.sessionNet()>=100){this.state.goal=true;this.pause('Session $100 goal reached; new entries paused. Manual-profit positions remain open.');this.save();}
      if(!this.newRules&&!this.experimentActive()&&this.state.goal)for(const r of this.active().filter(r=>r.exitPolicy!=='manual-profit-60s-loss'))await this.close(r.symbol,'$100 session goal');
      if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))this.pause('Unmanaged position detected; auto entries stopped.');
      if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId||r.lossReduction?.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))this.pause('Unmanaged orders detected; auto entries stopped.');
      if(this.auto&&Date.now()-this.lastScan>=1000)await this.scan();
      await this.scanRiskCheck();await this.reviewContinuation();
      this.block='';this.retryAt=0;this.retryAttempt=0;
    }catch(e){if(!this.scheduleReadRecovery(e)){this.block=e.message;this.pause(e.message);}}finally{this.busy=false;this.notify();}
  }
}
if(typeof module!=='undefined')module.exports={trialProfitFloor,netProfitFloor,selectEntryCandidate,ENTRY_MARGIN,MAX_ENTRY_LEVERAGE,candleTrend,momentumSetup,entryPriceReason,signalLeverageCeiling,DemoAPI,DemoEngine,DemoError,rounded,breakout,twoMinuteBars,aggregateMinutes,aggregateFiveMinuteBars,qualifySetup,experimentSignal,profitFloor,recoverySignal,entryMomentum,entryQuoteCheck,adaptiveLeveragePlan,exitPrice,combinedValue,DEMO_BASE};

