'use strict';
const APP_VERSION='1.77';
const SESSION_TARGET=20;
const BAND_TIMEFRAMES=Object.freeze([1,2,3,4,5,6,7,8,9,10,15,20,30,60]);
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
function validAlgoClientId(value){return typeof value==='string'&&/^[.A-Z:/a-z0-9_-]{1,36}$/.test(value);}
function algoExchangeId(value){
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
  return typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n?value:null;
}
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
  if(!Number.isInteger(minutes)||minutes<2||minutes>10)throw new DemoError('Unsupported aggregation');
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
function momentumSetup(raw,trend,now,intervalMs=60000,explain=()=>{},confirmationMs=300000){
  const reject=reason=>{explain(reason);return null;};
  const direction=candleTrend(raw,now,intervalMs),confirmation=candleTrend(trend,now,confirmationMs);
  if(!direction.side)return reject(direction.reason||'No aligned candle momentum');
  if(confirmation.side!==direction.side)return reject(confirmationMs/60000+'m trend does not confirm current momentum');
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
function trendContinuationSetup(minute,five,side,now,explain=()=>{}){
  const reject=reason=>{explain(reason);return null;};
  if(!['BUY','SELL'].includes(side))return reject('Trend entry requires a current gainer/loser direction');
  let reason;const setup=momentumSetup(minute,five,now,60000,r=>reason=r,300000);
  if(!setup)return reject(reason||'No confirmed 1m/5m trend continuation');
  if(setup.side!==side)return reject('Current 1m/5m trend opposes the gainer/loser direction');
  const referenceTarget=setup.price+(side==='BUY'?1:-1)*2*setup.atr;
  if(!(referenceTarget>0))return reject('Invalid trend reference price');
  return {...setup,setupType:'trend-continuation',referenceTarget,referenceAtr:2,trendEvidence:{oneMinute:candleTrend(minute,now,60000),fiveMinute:candleTrend(five,now,300000),volumeRatio:setup.volumeRatio,body:setup.body,closeStrength:setup.closeStrength},referenceNote:'Two observed 1m ATRs are a cost-check reference, not a profit forecast or fixed take-profit'};
}
function entryPriceReason(price,signal,{tolerant=false}={}){
  if(!(Number.isFinite(price)&&price>0&&Number.isFinite(signal.price)&&signal.price>0&&Number.isFinite(signal.atr)&&signal.atr>0)||!['BUY','SELL'].includes(signal.side))return 'Invalid entry price or signal';
  if(Math.abs(price-signal.price)>(tolerant?.75:.5)*signal.atr)return 'Price moved too far from the confirmed candle';
  if(signal.setupType==='bollinger-wr'){
    const b=signal.bands;if(!b||![b.lower,b.middle,b.upper].every(Number.isFinite)||!(b.lower<b.middle&&b.middle<b.upper))return 'Invalid Bollinger targets';
    if(signal.side==='BUY'?(price<=b.lower||price>=b.middle):(price>=b.upper||price<=b.middle))return 'Price left the Bollinger entry zone or reached the middle target';
    return null;
  }
  const trend=['momentum','trend-continuation'].includes(signal.setupType);
  if(signal.setupType==='trend-continuation'&&(!(signal.referenceTarget>0)||(signal.referenceTarget-price)*(signal.side==='BUY'?1:-1)<=0))return 'Trend reference price already reached; do not chase';
  const boundary=trend?signal.invalidationPrice:signal.side==='BUY'?signal.high:signal.low;
  const retest=tolerant&&!trend?.1*signal.atr:0;
  const distance=(price-boundary)*(signal.side==='BUY'?1:-1);
  if(!Number.isFinite(boundary)||(retest?distance < -retest-1e-10:distance<=0))return trend?'Momentum reversed before entry':'Breakout reversed before entry';
  return null;
}
function signalLeverageCeiling(signal,market,now){
  const strength=Number(signal.strength),base=strength>=3?10:strength>=2?5:3;
  const fresh=market&&Number.isFinite(market.closedAt)&&now>=market.closedAt&&now-market.closedAt<=315000;
  return fresh&&market.side===signal.side?base:Math.min(3,base);
}
function selectEntryCandidate(primary,{price,fee,now,traded=()=>false,confirm=()=>null,intervals=[1,2,3,4,5,10,15,20,30,60],maxCandidates=intervals.length}){
  const choices=[primary,...(Array.isArray(primary.alternatives)?primary.alternatives:[])].slice(0,maxCandidates),checks=[];
  for(const candidate of choices){
    const {alternatives,...signal}=candidate,intervalMs=signal.intervalMs||300000;
    let reason;
    if(signal.side!==primary.side||!signal.qualityConfirmed||!(signal.strength>=1)||![3,5,8].includes(signal.leverage)||!(signal.stopDistance>0&&Number.isFinite(signal.stopDistance))||!(signal.atr>0&&Number.isFinite(signal.atr))||!Number.isFinite(signal.price))reason='Invalid or opposite-direction candidate';
    else if(!intervals.includes(intervalMs/60000)||!Number.isFinite(signal.close)||signal.close>=now||now-signal.close>intervalMs+15000)reason='Signal became stale';
    else if(traded(signal))reason='Already traded this candle';
    else reason=entryPriceReason(price,signal,{tolerant:true});
    if(!reason&&signal.setupType==='bollinger-wr'&&Math.abs(signal.bands.middle-price)<4*fee*(price+signal.bands.middle))reason='Commission exceeds 25% of the gross move to the middle-band reference target';
    if(!reason&&signal.setupType==='trend-continuation'&&Math.abs(signal.referenceTarget-price)<4*fee*(price+signal.referenceTarget))reason='Commission exceeds 25% of the trend reference move';
    if(!reason&&!['bollinger-wr','trend-continuation'].includes(signal.setupType)&&2*signal.atr<=3*(2*price*fee))reason='Estimated candle movement too small relative to round-trip commission';
    if(!reason)reason=confirm({...signal,intervalMs});
    checks.push({minutes:intervalMs/60000,side:signal.side,setupType:signal.setupType||'breakout',reason:reason||'Entry candidate selected'});
    if(!reason)return {signal:{...signal,intervalMs},checks};
  }
  return {signal:null,checks};
}
function bandEntryCosts(signal,entry,qty,fee){
  const target=Number(signal.setupType==='trend-continuation'?signal.referenceTarget:signal.bands?.middle),gross=(target-entry)*(signal.side==='BUY'?1:-1)*qty;
  const commission=(entry+target)*qty*fee,net=gross-commission;
  const reason=!(target>0&&entry>0&&qty>0&&fee>=0&&Number.isFinite(gross)&&Number.isFinite(commission))?'Invalid target cost estimate':gross<=0?'Reference target is behind the entry price':commission>gross*.25+1e-8?'Opening + closing commission would consume more than 25% of the reference target move':net<5-1e-8?'Reference target leaves less than $5 after estimated opening + closing commission':null;
  return {referenceTarget:target,grossAtTarget:gross,commissionAtTarget:commission,netAtTarget:net,maxCommissionShare:.25,minimumNetAtTarget:5,reason};
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
  const atr=bars.slice(-20).reduce((sum,b,i)=>sum+Math.max(number(b[2])-number(b[3]),Math.abs(number(b[2])-number(bars[bars.length-21+i][4])),Math.abs(number(b[3])-number(bars[bars.length-21+i][4]))),0)/20;
  const evidence={atr,close,open,fast,slow,body:range>0?Math.abs(close-open)/range:0,closeStrength:range>0?(buy?close-low:high-close)/range:0,previousClose:number(previous[4]),threeBarsAgo:number(bars.at(-4)[4]),closedAt:number(last[6]),side};
  if(!(buy?close>open&&close>number(previous[4])&&close>fast&&fast>slow:close<open&&close<number(previous[4])&&close<fast&&fast<slow))return {...evidence,reason:'Latest 1m movement no longer confirms '+side};
  if(range<=0||Math.abs(close-open)/range<.4||(buy?(close-low)/range:(high-close)/range)<.65)return {...evidence,reason:'Latest 1m candle body/close does not confirm '+side};
  return evidence;
}
// An additional exit only: observed deterioration is evidence, not a price forecast.
// Eligible from $2 net loss until the existing $6 loss rules take over.
// Reaching $2 alone, fees alone and a single adverse tick are insufficient.
function earlyLossDecision(r,quote,now,observations=[],momentum=null){
  const hold=reason=>({exit:false,reason});
  if(!quote||![quote.net,quote.gross,quote.price,quote.at,quote.quantity,now].every(Number.isFinite)||quote.price<=0||quote.quantity<=0||now-quote.at>5000||quote.at>now)return hold('Fresh executable closing estimate required');
  if(quote.net>-2)return hold('Early loss exit waits for at least $2 net loss and adverse movement');
  if(quote.net<=-6)return hold('Existing $6 recovery and $12 backup loss rules take precedence');
  if(quote.net>=0||quote.gross>=0)return hold('No losing price move; fees alone do not trigger an early exit');
  const sign=r.side==='BUY'?1:r.side==='SELL'?-1:0,entry=Number(r.entry),tick=Number(r.tick),atr=Number(r.signal?.atr);
  if(!sign||!(entry>0&&tick>0&&atr>0))return hold('Entry price, tick size and volatility evidence required');
  const adverseDistance=sign*(entry-quote.price),noise=Math.max(2*tick,.05*atr);
  if(adverseDistance+1e-10<noise)return hold('Adverse price movement is still within the noise allowance');
  const samples=observations.filter(q=>q&&Number.isFinite(q.at)&&Number.isFinite(q.price)&&q.price>0&&q.at<=now&&now-q.at<=15000&&q.entry===entry&&q.quantity===quote.quantity).slice(-3);
  if(samples.length===3){
    const [a,b,c]=samples;
    if(b.at-a.at>=1000&&c.at-b.at>=1000&&now-c.at<=5000&&sign*(b.price-a.price)<-1e-10&&sign*(c.price-b.price)<-1e-10&&sign*(quote.price-c.price)<=1e-10&&sign*(a.price-quote.price)+1e-10>=noise)
      return {exit:true,mode:'prices',reason:'Three fresh executable prices moved against the trade; the latest quote still confirms deterioration',adverseDistance,noise,samples};
  }
  const m=momentum,openedAt=Number(r.openedAt||r.at);
  if(m&&[m.closedAt,m.atr,m.close,m.open,m.previousClose,m.fast,m.slow,m.threeBarsAgo,openedAt].every(Number.isFinite)&&m.atr>0&&m.closedAt>=openedAt&&m.closedAt<now&&now-m.closedAt<=75000){
    const sharp=sign*(m.close-m.open)<=-.6*m.atr&&sign*(m.close-m.previousClose)<=-.3*m.atr;
    const sustained=sign*(m.close-m.fast)<0&&sign*(m.fast-m.slow)<0&&sign*(m.close-m.threeBarsAgo)<=-.8*m.atr;
    if((sharp||sustained)&&sign*(quote.price-m.close)<=.1*m.atr)
      return {exit:true,mode:'candle',reason:'Strong opposing 1m movement after entry remains confirmed by the executable price',adverseDistance,noise,momentum:m};
  }
  return hold('No confirmed deterioration; existing exits remain active');
}
function entryConfirmation(raw,signal,now,trendRaw){
  const current=entryMomentum(raw,signal.side,now),minutes=(signal.intervalMs||300000)/60000;
  if(signal.setupType==='trend-continuation'){
    if(!Array.isArray(trendRaw))return {...current,reason:'Fresh 5m trend confirmation required'};
    let reason;const fresh=trendContinuationSetup(raw,trendRaw,signal.side,now,r=>reason=r);
    return {...current,reason:fresh?null:reason,signalMinutes:1,trendEvidence:fresh?.trendEvidence,confirmation:fresh?'Closed 1m and 5m trends confirm '+signal.side+'; live continuation still required':null};
  }
  if(signal.setupType==='bollinger-wr'){
    // A lower-band rebound is below the 20-close middle by definition. Requiring
    // the momentum strategy's close > fast > slow here would reject every LONG
    // (and the mirrored SHORT). Revalidate the actual reversal strategy instead.
    if(minutes===1){
      let reason;
      if(!bollingerSetup(raw,signal.side,now,r=>reason=r,60000))return {...current,reason:'Latest 1m band setup: '+reason,signalMinutes:1};
    }
    if(!(current.atr>0)||!Number.isFinite(current.closedAt))return current;
    const sign=signal.side==='BUY'?1:-1;
    if(sign*(current.close-current.open)<=0||sign*(current.close-current.previousClose)<=0||current.body<.4||current.closeStrength<.65)
      return {...current,signalMinutes:minutes,reason:'Current 1m direction does not confirm '+signal.side+'; wait for a strong closed candle in the trade direction'};
    return {...current,reason:null,signalMinutes:minutes,confirmation:'Closed 1m candle confirms '+signal.side+'; live continuation still required'};
  }
  if(minutes<=1||!current.reason)return {...current,signalMinutes:minutes};
  if(!(current.atr>0)||!Number.isFinite(current.closedAt))return current;
  const sign=signal.side==='BUY'?1:-1;
  // Longer setups can survive a small 1m pullback. A sharp counter candle or
  // a sustained opposing short-term trend still invalidates the entry.
  const sharp=Math.min(sign*(current.close-current.open),sign*(current.close-current.previousClose))<=-.6*current.atr;
  const opposing=sign*(current.close-current.fast)<0&&sign*(current.fast-current.slow)<0;
  const sustained=sign*(current.close-current.threeBarsAgo)<=-.8*current.atr;
  if(sharp||(opposing&&sustained))return {...current,reason:'Current 1m reversal opposes the '+minutes+'m '+signal.side+' setup'};
  return {...current,reason:null,signalMinutes:minutes,confirmation:'Small 1m pullback allowed; selected timeframe and price boundary remain valid'};
}
function bandEntryLiveCheck(before,quote,momentum,{symbol,side,tick,now,raw,checkpoint}){
  const sign=side==='BUY'?1:side==='SELL'?-1:0;
  const evidence={checkedAt:now,side,baseline:before,quote,oneMinute:momentum};
  const reject=reason=>({...evidence,reason});
  if(!sign||!(Number(tick)>0)||!momentum||momentum.reason||!(momentum.atr>0)||!Number.isFinite(momentum.closedAt)||momentum.closedAt>=now||now-momentum.closedAt>75000)return reject('Fresh aligned 1m evidence required before entry');
  for(const q of [before,quote])if(!q||q.symbol!==symbol||![q.bidPrice,q.askPrice,q.time].every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v)))||!(Number(q.bidPrice)>0)||Number(q.askPrice)<Number(q.bidPrice))return reject('Fresh valid bid and ask observations required before entry');
  const firstAt=Number(before.time),lastAt=Number(quote.time);
  if(firstAt>now||now-firstAt>10000||lastAt>now||now-lastAt>5000||lastAt<=firstAt)return reject('Waiting for two fresh, distinct market quotes; no entry from stale or repeated prices');
  const minimumMove=Math.max(2*Number(tick),.05*momentum.atr),bidMove=sign*(Number(quote.bidPrice)-Number(before.bidPrice)),askMove=sign*(Number(quote.askPrice)-Number(before.askPrice));
  Object.assign(evidence,{minimumMove,bidMove,askMove});
  if(bidMove+1e-10<minimumMove||askMove+1e-10<minimumMove)return reject('Waiting for both bid and ask to move '+(side==='BUY'?'up before BUY':'down before SELL')+'; flat, opposing or spread-only moves do not qualify');
  if(checkpoint&&(Number(checkpoint.time)<firstAt||Number(checkpoint.time)>lastAt))return reject('Market quote timestamps arrived out of order; wait for fresh direction evidence');
  if(checkpoint&&(sign*(Number(quote.bidPrice)-Number(checkpoint.bidPrice))<-1e-10||sign*(Number(quote.askPrice)-Number(checkpoint.askPrice))<-1e-10))return reject('Live direction reversed during exchange settings; waiting for a new setup check');
  if(checkpoint)evidence.beforeSettings=checkpoint;
  const executable=Number(side==='BUY'?quote.bidPrice:quote.askPrice),distance=sign*(executable-momentum.close);
  if(distance<-1e-10)return reject('Live price reversed beyond the latest closed 1m price');
  if(distance>.75*momentum.atr+1e-10)return reject('Live move is too extended from the latest 1m candle; do not chase');
  const last=raw?.at(-1);
  if(last&&Number(last[6])>=now){
    const [start,open,high,low,close,volume,end]=last.map(Number);
    if(![start,open,high,low,close,volume,end].every(Number.isFinite)||start!==momentum.closedAt+1||start>now||end-start!==59999||!(low>0)||high<low||open<low||open>high||close<low||close>high||volume<0)return reject('Current forming 1m candle is invalid');
    evidence.forming={start,open,high,low,close,end};
    if(sign*(close-open)<=0||sign*(executable-open)<=0)return reject('Current forming 1m candle is flat or moving against '+side);
  }
  return {...evidence,reason:null,confirmation:'Fresh closed candle and both live quotes confirm '+side};
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
function adaptiveLeveragePlan({price,atr,fee,lossLimit,side,tick,plan,maxLeverage=MAX_ENTRY_LEVERAGE,requireStop=true,leverageLimit=MAX_ENTRY_LEVERAGE,maxFees=Infinity}){
  if(!(price>0&&atr>0&&fee>=0&&fee<=.01&&lossLimit>0))throw new DemoError('Invalid adaptive sizing inputs');
  // Bound entry exposure using one recent ATR plus fees; this need not be an exit.
  // ATR is observed volatility, never a win probability or a profit forecast.
  if(![MAX_ENTRY_LEVERAGE,150].includes(leverageLimit)||!Number.isInteger(maxLeverage)||maxLeverage<1||maxLeverage>leverageLimit)throw new DemoError('Invalid leverage ceiling');
  for(let leverage=maxLeverage;leverage>=1;leverage--){
    const size=plan(leverage),movementLoss=size.qty*atr;
    const estimatedFees=size.qty*(2*price+atr)*fee;
    if(movementLoss+estimatedFees>lossLimit+1e-8||2*size.qty*price*fee>maxFees+1e-8)continue;
    const stop=requireStop?number(exitPrice(price,size.qty,fee,-lossLimit,side,tick)):null;
    const stopDistance=requireStop?(side==='BUY'?price-stop:stop-price):null;
    if(requireStop&&stopDistance+1e-8<atr)continue;
    return {leverage,atr,movementLoss,estimatedFees,estimatedLossAtOneAtr:movementLoss+estimatedFees,stopDistance};
  }
  return null;
}
function trialProfitFloor(peak){if(!Number.isFinite(peak)||peak<=2)return null;const levels=[2,4,8,10];if(peak<=10)return levels.filter(v=>v<peak).at(-1);return 10+5*Math.max(0,Math.ceil((peak-10)/5)-1);}
function steppedProfitFloor(peak){if(!Number.isFinite(peak)||peak<=5)return null;return 5+3*Math.max(0,Math.ceil((peak-5)/3)-1);}
function netProfitFloor(peak){if(!Number.isFinite(peak)||peak<=2)return null;if(peak<=10)return Math.max(2,2*(Math.ceil(peak/2)-1));return 10+5*Math.max(0,Math.ceil((peak-10)/5)-1);}
function bollingerSnapshot(raw,now,intervalMs=300000){
  if(!BAND_TIMEFRAMES.includes(intervalMs/60000))throw new DemoError('Unsupported Bollinger timeframe');
  breakout(raw,now,intervalMs);
  const bars=raw.filter(b=>number(b[6])<now);
  if(bars.length<21||now-number(bars.at(-1)[6])>intervalMs+15000)return null;
  const calculate=rows=>{
    const closes=rows.slice(-20).map(b=>number(b[4])),middle=closes.reduce((s,x)=>s+x,0)/20;
    const deviation=Math.sqrt(closes.reduce((s,x)=>s+(x-middle)**2,0)/20),last=rows.at(-1);
    const highest=Math.max(...rows.slice(-14).map(b=>number(b[2]))),lowest=Math.min(...rows.slice(-14).map(b=>number(b[3])));
    return {middle,upper:middle+2*deviation,lower:middle-2*deviation,wr:highest>lowest?-100*(highest-number(last[4]))/(highest-lowest):null,close:number(last[4]),open:number(last[1]),high:number(last[2]),low:number(last[3]),closedAt:number(last[6])};
  };
  for(const b of bars)if(number(b[1])<number(b[3])||number(b[1])>number(b[2]))throw new DemoError('Invalid candle open');
  const current=calculate(bars),previous=calculate(bars.slice(0,-1));
  const atr=bars.slice(-20).reduce((sum,b,i)=>sum+Math.max(number(b[2])-number(b[3]),Math.abs(number(b[2])-number(bars[bars.length-21+i][4])),Math.abs(number(b[3])-number(bars[bars.length-21+i][4]))),0)/20;
  return {...current,previous,atr};
}
function bollingerSetup(raw,side,now,explain=()=>{},intervalMs=300000){
  const reject=reason=>{explain(reason);return null;},b=bollingerSnapshot(raw,now,intervalMs),frame=intervalMs/60000+'m';
  if(!b||!(b.atr>0)||b.wr===null||b.previous.wr===null||!(b.upper>b.lower))return reject('Fresh '+frame+' Bollinger / Williams %R history unavailable');
  const buy=side==='BUY',p=b.previous;
  if(!['BUY','SELL'].includes(side))return reject('Not in the current futures gainers/losers list');
  const touched=buy?(p.low<=p.lower||b.low<=b.lower):(p.high>=p.upper||b.high>=b.upper);
  if(!touched)return reject('No '+(buy?'lower':'upper')+'-band touch on the last two '+frame+' candles');
  if(!(buy?Math.min(p.wr,b.wr)<=-80:Math.max(p.wr,b.wr)>=-20))return reject('Williams %R has not reached the required extreme');
  if(!(buy?b.close>b.open&&b.close>p.close&&b.wr>p.wr&&b.close>b.lower:b.close<b.open&&b.close<p.close&&b.wr<p.wr&&b.close<b.upper))return reject('Band touched; waiting for a closed '+frame+' bounce/rejection');
  if(!(buy?b.close<b.middle:b.close>b.middle))return reject('Middle-band target already reached; do not chase');
  const outerTarget=b.middle+.9*((buy?b.upper:b.lower)-b.middle),strength=1+Number(buy?p.wr<=-90:p.wr>=-10);
  return {side,price:b.close,close:b.closedAt,high:b.high,low:b.low,atr:b.atr,stopDistance:1.5*b.atr,qualityConfirmed:true,strength,leverage:3,intervalMs,setupType:'bollinger-wr',bands:{...b,outerTarget},invalidationPrice:buy?b.lower:b.upper};
}
class DemoEngine {
  constructor(api,state,persist,notify=()=>{}){
    this.bandRules=true;
    this.resultResetSupported=true;
    this.entryPolicy={margin:300,marginMode:'fixed',leverageMode:'highest-fee-compatible',maxLeverage:150,maxCommissionShare:.25,maxCommissionLossShare:.5,minimumNetAtTarget:5,strategy:'bollinger-wr-and-trend-continuation',strategies:['bollinger-wr','trend-continuation'],trendTimeframes:[1,5],trendReferenceAtr:2,trendVolatilityLossLimit:6,entryDirection:'closed-1m-and-live-quotes',timeframes:[...BAND_TIMEFRAMES],lossLimit:6,maxLossLimit:12,earlyLossExit:'confirmed-adverse-move',earlyLossMin:2,profitStart:5,profitStep:3,takeProfit:null,profitExit:'stepped-net-trailing',lossReduction:0,sessionTarget:SESSION_TARGET,sessionExit:'close-bot-positions',bollingerPeriod:20,bollingerDeviations:2,williamsPeriod:14};
    this.scanAudit={startedAt:Date.now(),checked:0,qualified:0,submitted:0,skipped:0,entryErrors:0,dataErrors:0,lastCheckAt:null,lastSubmittedAt:null,lastResult:null};
    this.appVersion=APP_VERSION;this.newRules=true;this.experimentUntil=LEVERAGE_OVERRIDE_UNTIL;this.overrideUntil=LEVERAGE_OVERRIDE_UNTIL;this.api=api;this.state=state||{version:1,records:[],startedAt:0,goal:false};this.persist=persist;this.notify=notify;this.auto=false;this.connected=false;this.busy=false;this.stopEpoch=0;this.account=null;this.positions=[];this.orders=[];this.algos=[];this.symbols=[];this.meta=new Map();this.cursor=0;this.scanned=[];this.lastScan=0;this.lastIncome=0;this.income=[];this.events=[];this.block='';this.balance=null;
    if(this.state.version!==1||!Array.isArray(this.state.records))throw new DemoError('Invalid demo journal. Do not start; inspect Binance Demo positions.');
    for(const r of this.state.records)if(!/^[A-Z0-9]+USDT$/.test(r.symbol)||!/^bd1_[a-zA-Z0-9_-]+$/.test(r.id)||!['BUY','SELL'].includes(r.side))throw new DemoError('Invalid saved demo order record.');
  }
  trialActive(now=Date.now()+this.api.offset){
    if(this.bandRules)return false;
    const t=this.state.oneHourTrial;
    return !!(this.newRules&&t&&Number.isFinite(t.startedAt)&&Number.isFinite(t.until)&&t.until-t.startedAt===3600000&&!t.endedAt&&now>=t.startedAt&&now<t.until);
  }
  async startTrial(){
    if(this.bandRules)throw new DemoError('The one-hour experiment was replaced by the multi-timeframe Bollinger strategy. Use Start / Resume Demo.');
    if(!this.newRules)throw new DemoError('Update the engine before starting the one-hour experiment');
    if(this.trialActive())return false; // repeated clicks never extend an active hour
    const epoch=this.stopEpoch;await this.start();
    if(!this.auto||epoch!==this.stopEpoch)return false;
    const at=Date.now()+this.api.offset;
    this.state.oneHourTrial={id:'trial_'+at,startedAt:at,until:at+3600000,scope:'new-positions',lossExit:'any-negative-net',maxMargin:300,maxLeverage:150,entryStrategy:'timeframe-aware-v2',leveragePolicy:'volatility-and-fees',maxEstimatedFees:2,profitFloors:[2,4,8,10],profitStep:5};
    this.save();this.event('One-hour Demo experiment started. Timeframe-aware momentum/breakout setups only. Leverage adapts to volatility and fees within Binance limits, up to 150×; up to $300 margin. Any negative estimated net triggers closure, including fees. New entries revert at '+new Date(at+3600000).toISOString()+'. Existing positions keep their recorded exits.');return true;
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
  pause(reason){this.retryAt=0;this.retryAttempt=0;this.retryLimited=false;this.entryHold='';this.startPending=false;this.auto=false;this.stopEpoch++;this.scanController?.abort();if(reason)this.event(reason);}
  holdEntries(reason){
    if(!this.bandRules){this.pause(reason);return;}
    const changed=this.entryHold!==reason;this.entryHold=reason;this.block=reason;this.scanController?.abort();
    if(changed)this.event('New entries waiting; position management continues when Binance is reachable. '+reason);
  }
  handleRunError(error){
    if(this.scheduleReadRecovery(error))return;
    this.block=error.message;
    if(this.bandRules&&this.auto){this.holdEntries(error.message);this.retryAt=Math.max(this.retryAt||0,Date.now()+5000);}
    else this.pause(error.unseenFill&&this.events[0]?.text===error.message?undefined:error.message);
  }
  entrySafetyReason(){
    if(this.active().some(r=>r.pendingClose||r.lossReduction?.status==='PENDING'||!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(r.entryStatus)||(!(this.newRules?r.exitsReady:r.protected)&&!this.exitsSuspended(r))))return 'Pending orders or unverified exits; reconciling before new entries';
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))return 'Unmanaged Binance position; waiting for it to be resolved';
    if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId||r.lossReduction?.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))return 'Unmanaged Binance order; waiting for it to be resolved';
    return null;
  }
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
    if(this.bandRules&&this.state.oneHourTrial&&!this.state.oneHourTrial.endedAt){this.state.oneHourTrial.endedAt=Date.now()+this.api.offset;this.state.oneHourTrial.endReason='Replaced by multi-timeframe Bollinger strategy';this.save();}
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
    const state=this.state,startTime=state.startedAt,out=[],endTime=Date.now()+this.api.offset;
    if(endTime-startTime>7*86400000)throw new DemoError('Session exceeds 7 days. Review results and start a new session when flat.');
    for(let page=1;page<=20;page++){
      const rows=await this.api.call('GET','/fapi/v1/income',{startTime,endTime,page,limit:1000});
      // A late response from the previous session must never overwrite a reset.
      if(this.state!==state||this.state.startedAt!==startTime)return;
      if(!Array.isArray(rows))throw new DemoError('Invalid income response');out.push(...rows);
      if(rows.length<1000){
        const relevant=out.filter(x=>x.asset==='USDT'&&['REALIZED_PNL','COMMISSION','FUNDING_FEE'].includes(x.incomeType));
        for(const x of relevant){number(x.income);if(!Number.isSafeInteger(number(x.time))||number(x.time)<=0)throw new DemoError('Invalid income timestamp');}
        const complete=relevant.filter(x=>number(x.time)>=startTime&&number(x.time)<=endTime);
        this.income=complete;this.incomeWindowStart=startTime;this.incomeWindowEnd=endTime;this.lastIncome=Date.now();return;
      }
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
    if(row.entryResult?.kind==='exchange-rejected')audit.exchangeRejected=(audit.exchangeRejected||0)+1;
    if(row.entryResult?.kind==='app-filter')audit.appFiltered=(audit.appFiltered||0)+1;
    if(row.entryResult?.kind==='data-unavailable')audit.readUnavailable=(audit.readUnavailable||0)+1;
    audit.lastResult={symbol:row.symbol,phase:row.phase,reason:row.reason};
  }
  scanDiagnostics(){
    const now=Date.now(),audit=this.scanAudit||null,lastCompleted=audit?.lastCheckAt||this.scanned[0]?.at||null;
    const progressAt=lastCompleted||this.scanStats?.startedAt||this.lastScan||null;
    const elapsed=progressAt?Math.floor((now-progressAt)/1000):null;
    let status;
    if(!this.connected)status='Disconnected: no new entries can be sent.';
    else if(this.state.goalStopAt)status='$'+SESSION_TARGET+' session stop is locked. Start a new session while flat to resume.';
    else if(this.accountingUpdateRequired)status='LAPTOP CONNECTOR UPDATE REQUIRED: fee-history requests are unsupported. No new entries can be sent. Download the current files and restart START-LAPTOP.cmd; refreshing this page is not enough.';
    else if(this.startPending&&this.auto)status='Start requested; verifying connection and order protection before scanning. '+(this.retryAt>Date.now()?'Retrying automatically in '+Math.ceil((this.retryAt-Date.now())/1000)+' seconds. ':'')+(this.block||'');
    else if(!this.tradingReady)status='Balance connected; trading checks are incomplete. '+(this.block||'Use Retry connection.');
    else if(!this.auto)status='New entries are stopped; open-position checks continue while connected. '+(this.block||'Use Start / Resume Demo to scan and enter.');
    else if(this.retryAt>Date.now())status='Auto enabled; temporary connection delay. Retrying in '+Math.ceil((this.retryAt-Date.now())/1000)+' seconds. '+(this.block||'');
    else if(this.entryHold&&this.auto)status='Auto enabled; new entries waiting. Position management continues when Binance is reachable. '+this.entryHold;
    else if(this.controlPending)status='A manual action is queued or running; new entries wait for it.';
    else if(!this.symbols.length)status='No eligible markets have been loaded.';
    else if(elapsed!==null&&elapsed>90)status='No completed coin check for '+elapsed+' seconds. '+(this.block||this.entryOutcome||'Check connection and last scan times.');
    else status='Auto scanning. '+(audit?audit.checked+' completed coin checks; '+audit.qualified+' candle setups; '+audit.submitted+' confirmed order submissions; '+audit.skipped+' entry skips; '+(audit.entryErrors||0)+' entry errors; '+audit.dataErrors+' data errors. Reasons: '+(audit.appFiltered||0)+' app filters; '+(audit.readUnavailable||0)+' entry-data failures; '+(audit.exchangeRejected||0)+' Binance order rejections.':'Detailed counters unavailable from this engine.')+(audit?.lastResult?' Latest: '+audit.lastResult.symbol+' — '+audit.lastResult.reason:' Waiting for first completed check.');
    return {reportType:'scan-diagnostics',appVersion:this.appVersion||null,generatedAt:new Date(now).toISOString(),status,connected:this.connected,tradingReady:!!this.tradingReady,auto:this.auto,entryHold:this.entryHold||null,lastRiskCheck:this.lastRiskCheck||null,startPending:!!this.startPending,retryAt:this.retryAt||null,accountingUpdateRequired:!!this.accountingUpdateRequired,busy:this.busy,controlPending:!!this.controlPending,block:this.block||null,entryPolicy:this.entryPolicy||null,oneHourTrial:this.state.oneHourTrial||null,trialActive:this.trialActive(),marketCount:this.symbols.length,lastScanStartedAt:this.lastScan||null,lastCompletedCheckAt:lastCompleted,scanAudit:audit,scan:this.scanStats||null,marketContext:this.marketContext||null,pendingEntries:this.active().filter(r=>r.reconcileError).map(r=>({symbol:r.symbol,entryStatus:r.entryStatus,observedOpen:!!r.observedOpen,reason:r.reconcileError.message})),recentFlatRecoveries:this.state.records.filter(r=>r.flatRecovery).slice(-5).map(r=>({symbol:r.symbol,...r.flatRecovery})),localSnapshotOnly:true,note:'No trades or fresh account requests are required. Counts are checks since this engine loaded, not unique coins or profit predictions.',recentChecks:this.scanned.slice(0,30).map(s=>({symbol:s.symbol,setupType:s.setupType,at:s.at,side:s.side,source:s.source,phase:s.phase,reason:s.reason,entryResult:s.entryResult||null,scanMs:s.scanMs,entryMs:s.entryMs,checks:s.checks,entryCandidates:s.entryCandidates,entryDirection:s.entryDirection||null})),requests:(this.api.timings||[]).slice(-30).map(r=>({at:r.at,method:r.method,path:r.path,ms:r.ms,ok:r.ok,code:r.code}))};
  }
  tradeReport(){
    const now=Date.now(),incomeReady=!!this.lastIncome&&this.incomeWindowStart===this.state.startedAt;
    const positionReady=!!this.positionAt;
    const complete=incomeReady&&positionReady&&now-this.lastIncome<=30000&&now-this.positionAt<=30000;
    return {
      appVersion:APP_VERSION,sessionTarget:SESSION_TARGET,generatedAt:new Date().toISOString(),strategyValidatedForProfit:false,oneHourTrial:this.state.oneHourTrial||null,trialActive:this.trialActive(),
      windowStart:this.state.startedAt??null,incomeSnapshotAt:this.lastIncome||null,positionSnapshotAt:this.positionAt||null,
      snapshotStatus:{complete,income:!incomeReady?'missing':now-this.lastIncome>30000?'stale':'loaded',positions:!positionReady?'missing':now-this.positionAt>30000?'stale':'loaded'},
      incomeWindowEnd:incomeReady?this.incomeWindowEnd:null,
      diagnostics:{scan:this.scanStats||null,lastEntry:this.entryTiming||null,requestTimingScope:'Elapsed includes queue, signing, network and response parsing; not a network ping.',marketContext:this.marketContext||null,requests:(this.api.timings||[]).slice(-40),recentChecks:this.scanned.slice(0,20).map(s=>({symbol:s.symbol,phase:s.phase,reason:s.reason,at:s.at,scanMs:s.scanMs,candleClosedAt:s.candleClosedAt}))},
      scope:'Account-wide USDT income; includes manual trades. Bot records are separate. Snapshots may be at different times.',
      totals:incomeReady?this.incomeBreakdown():null,unrealized:positionReady?this.unrealizedPnl():null,openingUnrealized:this.state.dayOpenPnl||0,netSession:complete?this.sessionNet():null,
      incomeRowsOmitted:incomeReady?Math.max(0,this.income.length-200):0,
      income:incomeReady?this.income.slice(-200).map(x=>({symbol:x.symbol,time:x.time,type:x.incomeType,income:x.income,asset:x.asset})):[],
      botRecords:this.state.records.slice(-50).map(r=>({flatRecovery:r.flatRecovery||null,reconcileError:r.reconcileError||null,entryAppVersion:r.entryAppVersion||null,oneHourTrial:r.oneHourTrial||null,bandTargets:r.bandTargets||null,trendTargets:r.trendTargets||null,setupType:r.signal?.setupType||null,lossRecovery:r.lossRecovery||null,earlyLossReview:r.earlyLossReview||null,maxLossLimit:r.maxLossLimit??null,indicatorSnapshot:r.signal?.bands||null,symbol:r.symbol,side:r.side,at:r.at,closedAt:r.closedAt,status:r.entryStatus,rejected:!!r.rejected,rejectionCode:r.rejectionCode??null,retryAfter:r.retryAfter??null,entry:r.entry,quantity:r.filledQty??r.quantity,leverage:r.leverage,fee:r.fee,estimatedEntryMargin:r.estimatedEntryMargin,lossLimit:r.lossLimit,takeProfit:r.takeProfit??null,exitPolicy:r.exitPolicy||null,exitsReady:!!r.exitsReady,peak:r.peak,profitFloor:r.profitFloor,closeReason:r.closeReason||(r.closedAt?'Closed on Binance; cause unconfirmed':null),protectionError:r.protectionError||null,entryEvidence:r.entryEvidence,tradeAccounting:r.tradeAccounting||null,trailPeak:r.trailPeak??null,lossReduction:r.lossReduction||null,closingEstimate:r.closingEstimate||null,estimateError:r.estimateError||null}))
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
    if(!this.newRules||!this.state.startedAt||(!this.state.goalStopAt&&(!this.lastIncome||this.sessionNet()<SESSION_TARGET)))return false;
    const closingNet=this.state.goalStopAt?this.state.goalNet:await this.estimateSessionClose();
    if(!this.state.goalStopAt&&closingNet<SESSION_TARGET)return false;
    this.pause();
    if(!this.state.goalStopAt){this.state.goal=true;this.state.goalStopAt=Date.now()+this.api.offset;this.state.goalNet=closingNet;this.save();this.event('$'+SESSION_TARGET+' net session target reached. Closing all bot positions; new entries locked.');}
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
        await this.close(r.symbol,'$'+SESSION_TARGET+' net session target');
      }catch(error){failures.push(r.symbol+': '+error.message);}
    }
    for(const r of this.active())if(!failures.some(message=>message.startsWith(r.symbol+': ')))failures.push(r.symbol+': awaiting flat position confirmation');
    this.block=failures.length?'$'+SESSION_TARGET+' target reached; closure needs reconciliation: '+failures.join('; '):'$'+SESSION_TARGET+' target reached. Bot positions closed and new entries stopped. Use New $'+SESSION_TARGET+' session when flat to restart.';
    this.save();this.notify();if(failures.length)throw new DemoError(this.block);return true;
  }
  async start(){
    const epoch=this.stopEpoch;
    if(this.bandRules&&this.connected){this.auto=true;this.startPending=true;}
    try{await this.startChecked(epoch);}
    catch(error){
      // Preserve an explicit Start through a temporary read outage. The retry
      // must complete every startup check before tick can scan or place orders.
      if(epoch===this.stopEpoch&&this.connected){
        if(this.bandRules){this.startPending=true;this.handleRunError(error);return;}
        const wasAuto=this.auto;this.auto=true;
        if(this.scheduleReadRecovery(error)){this.startPending=true;return;}
        this.auto=wasAuto;
      }
      this.startPending=false;throw error;
    }
  }
  async startChecked(epoch){
    if(!this.connected)throw new DemoError('Connect demo credentials first');
    this.syncDaily();
    if(!this.tradingReady||Date.now()-this.metaAt>600000)await this.prepareTrading();else await this.refresh();
    if(epoch!==this.stopEpoch)return;
    if(this.newRules){await this.updateIncome();if(await this.enforceSessionGoal())return;}
    await this.reconcile();
    if(this.active().some(r=>r.pendingClose||r.lossReduction?.status==='PENDING'||(!(this.newRules?r.exitsReady:r.protected)&&!this.exitsSuspended(r))))throw new DemoError('Resolve pending orders or unverified exits before starting.');
    if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol))||this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))throw new DemoError('Unmanaged positions or orders exist in this demo account. Close/cancel them in Binance before starting this bot.');
    if(!this.newRules&&this.state.goal&&!this.experimentActive())throw new DemoError('Session $'+SESSION_TARGET+' goal reached. Use Earn $'+SESSION_TARGET+' again when flat.');
    if(!this.state.startedAt){this.state.startedAt=Date.now()+this.api.offset;this.save();}
    await this.updateIncome();if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=SESSION_TARGET){this.state.goal=true;this.save();throw new DemoError('Session goal already reached');}
    if(epoch!==this.stopEpoch)return;
    this.startPending=false;this.entryHold='';this.auto=true;this.retryAt=0;this.retryLimited=false;this.retryAttempt=0;this.block='';this.event(this.bandRules?'Auto enabled · 1–10m / 15m / 20m / 30m / 60m Bollinger (20, 2) + Williams %R (14), plus 1m / 5m trend continuation · gainers LONG / losers SHORT · $300 margin per entry · highest fee-compatible Binance leverage for that size · $6 normal after-fee loss exit / $12 backup; fresh recovery evidence required beyond $6 · net profit pullbacks $5 / $8 / $11 / +$3 · $'+SESSION_TARGET+' net session target':this.newRules?'Auto enabled · USDⓈ-M Demo · $300 target margin · adaptive 1–10× · net profit floors $2 / $4 / $6 / $8 / $10 / +$5 · trim 25% once at -$3 · close trade at -$5 · $'+SESSION_TARGET+' net session closes bot positions and stops entries':this.experimentActive()?'EXPERIMENT enabled · 50× · available USDT · no automatic exits on new positions until '+new Date(this.experimentUntil).toISOString():'Auto enabled · filtered signals · adaptive 3× / 5× / 8× cross · up to $100 margin per entry · $1,000 budget · $800 total margin cap');
  }
  async resetResult(){
    if(!this.newRules)throw new DemoError('Update the running engine before resetting the result counter.');
    this.pause('Resetting the net result counter. New entries stopped.');
    // Only a fresh account/position read is needed. Existing orders and trade
    // protection remain in place; resetting a counter must not erase ownership.
    await this.refresh({inventory:false,valuation:false});
    const previous=this.state,at=Date.now()+this.api.offset,openingUnrealized=this.unrealizedPnl();
    const sequence=(Number.isSafeInteger(previous.resultResetSequence)?previous.resultResetSequence:0)+1;
    const record={at,sequence,openingUnrealized,previousStartedAt:previous.startedAt,
      previousNet:this.lastIncome&&this.incomeWindowStart===previous.startedAt?this.sessionNet():null,
      previousIncomeAt:this.lastIncome||null};
    this.state={...previous,startedAt:at,resetAt:at,dayStart:Math.floor((at+14400000)/86400000)*86400000-14400000,
      dayOpenPnl:openingUnrealized,goal:false,resultResetSequence:sequence,resultResets:[...(previous.resultResets||[]),record]};
    delete this.state.goalStopAt;delete this.state.goalNet;
    try{this.save();}catch(error){this.state=previous;throw error;}
    this.income=[];this.incomeWindowStart=at;this.incomeWindowEnd=at;this.lastIncome=Date.now();this.sessionCloseEstimate=null;this.block='';
    this.event('Net result counter reset to $0.00. Trades, positions and protective orders kept. Auto stopped.');
    return {sequence,at,net:this.sessionNet(),openingUnrealized};
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
    const previous=this.state,resetAt=Date.now()+this.api.offset;
    this.state={version:1,records:[],startedAt:resetAt,goal:false,
      dayStart:Math.floor((resetAt+14400000)/86400000)*86400000-14400000,dayOpenPnl:0,
      budgetWalletBaseline:previous.budgetWalletBaseline,
      resetAt,resetBalance:this.balance,
      archives:[...(previous.archives||[]),{at:Date.now(),records:previous.records,startedAt:previous.startedAt,goal:previous.goal}]};
    try{this.save();}catch(error){this.state=previous;throw error;}
    // Flat inventory was verified above. The new accounting window starts at zero now.
    this.income=[];this.incomeWindowStart=resetAt;this.incomeWindowEnd=resetAt;this.lastIncome=Date.now();this.sessionCloseEstimate=null;
    this.scanned=[];this.cursor=0;this.lastScan=0;this.block='';
    this.events=[];this.event('Reset complete. Net trading result starts at $0.00 from now; previous trades archived. Auto stopped. Credentials kept.');
  }
  async again(){if(this.active().length||this.positions.some(p=>number(p.positionAmt)!==0)||this.orders.length||this.algos.length)throw new DemoError('Close positions and clear pending orders before another session');this.syncDaily();this.state.startedAt=Date.now()+this.api.offset;this.state.resetAt=this.state.startedAt;this.state.dayOpenPnl=0;this.state.goal=false;delete this.state.goalStopAt;delete this.state.goalNet;this.income=[];this.lastIncome=0;this.save();await this.start();}
  async queryEntry(r){return this.api.call('GET','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.id});}
  unseenFlatPosition(rows,symbol,{scoped=false}={}){
    if(!Array.isArray(rows)||rows.some(p=>!p||typeof p.symbol!=='string'||(scoped&&p.symbol!==symbol)||p.positionSide!=='BOTH'||!['string','number'].includes(typeof p.positionAmt)||!/^[-]?\d+(?:\.\d{1,18})?$/.test(String(p.positionAmt))))throw new DemoError('Fresh account/position confirmation is incomplete or inconsistent');
    return rows.find(p=>p.symbol===symbol&&!/^-?0+(?:\.0+)?$/.test(String(p.positionAmt)));
  }
  async confirmUnseenFlat(r,order,history){
    this.flatConfirmations??=new Map();
    const wait=reason=>{this.flatConfirmations.delete(r.id);throw new DemoError(r.symbol+' filled entry: '+reason+'; new entries wait for confirmation.');};
    const now=Date.now()+this.api.offset,updated=order.updateTime;
    // A recently acknowledged fill can precede position visibility. Elapsed
    // time alone never clears a record: corroborated live reads are required.
    if(!Number.isSafeInteger(updated)||updated<=0||now-updated<60000)wait('closing fills are not confirmed; the entry must settle before flat-state recovery');
    if(r.pendingClose||r.lossReduction?.status==='PENDING')wait('an existing close or reduction still needs reconciliation');
    const startedAt=Date.now();
    const [account,positions,orders,algos,entry]=await Promise.all([
      this.api.call('GET','/fapi/v3/account'),this.api.call('GET','/fapi/v3/positionRisk',{symbol:r.symbol}),
      this.api.call('GET','/fapi/v1/openOrders',{symbol:r.symbol}),this.api.call('GET','/fapi/v1/openAlgoOrders',{symbol:r.symbol}),this.queryEntry(r)
    ]);
    if(Date.now()-startedAt>15000)wait('fresh confirmation took too long; retrying');
    if(!account||!Array.isArray(account.assets))wait('fresh account confirmation is unavailable');
    const accountPosition=this.unseenFlatPosition(account.positions,r.symbol),position=this.unseenFlatPosition(positions,r.symbol,{scoped:true});
    if(position){this.flatConfirmations.delete(r.id);this.positions=[...this.positions.filter(p=>p.symbol!==r.symbol),...positions];this.positionAt=Date.now();return null;}
    if(accountPosition)wait('account and position snapshots disagree');
    if(!Array.isArray(orders)||!Array.isArray(algos))wait('fresh order inventory is unavailable');
    if(orders.length||algos.length)wait('Binance still reports open orders on this symbol');
    if(!entry||entry.symbol!==r.symbol||entry.clientOrderId!==r.id||entry.side!==r.side||entry.status!=='FILLED'||String(entry.orderId)!==String(order.orderId)||String(entry.executedQty)!==String(order.executedQty)||entry.updateTime!==updated)wait('entry identity or settled quantity changed during verification');
    const checkedAt=Date.now(),identity=[String(order.orderId),String(order.executedQty),updated].join(':'),previous=this.flatConfirmations.get(r.id);
    if(!previous||previous.identity!==identity||checkedAt-previous.checkedAt>60000||checkedAt<previous.checkedAt){
      this.flatConfirmations.set(r.id,{identity,checkedAt,exchangeAt:checkedAt+this.api.offset});
    }else if(startedAt-previous.checkedAt>=5000){
      return {kind:'repeated-flat-snapshots',entryOrderId:String(order.orderId),executedQty:String(order.executedQty),entryUpdatedAt:updated,firstConfirmedAt:previous.exchangeAt,secondConfirmedAt:checkedAt+this.api.offset,closedAt:checkedAt+this.api.offset,closingHistoryConfirmed:false,closingTimeKnown:false,...history};
    }
    const error=new DemoError(r.symbol+' filled entry: closing fills are not confirmed; Binance account, position and orders are flat (check 1 of 2). Rechecking automatically before releasing startup.');error.flatConfirmationPending=true;throw error;
  }
  async recoverUnseenFill(r,order){
    this.unseenFillChecks??=new Map();const cached=this.unseenFillChecks.get(r.id);
    if(cached&&Date.now()<cached.retryAt)throw cached.error;
    const wait=reason=>{throw new DemoError(r.symbol+' filled entry: '+reason+'; new entries wait for confirmation.');};
    const id=value=>{if((typeof value==='number'&&!Number.isSafeInteger(value))||!/^\d+$/.test(String(value))||BigInt(value)<=0n)wait('invalid execution identifier');return BigInt(value).toString();};
    // Exact quantities prevent a small remaining position being rounded to flat.
    const units=value=>{const text=String(value);if(!/^\d+(?:\.\d{1,18})?$/.test(text))wait('invalid execution quantity');const [whole,fraction='']=text.split('.');return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));};
    const check=t=>{
      if(!t||t.symbol!==r.symbol||t.positionSide!=='BOTH'||!['BUY','SELL'].includes(t.side)||!Number.isSafeInteger(t.time)||t.time<=0||t.time>Date.now()+this.api.offset+5000)wait('execution history is incomplete or inconsistent');
      const tradeId=id(t.id),orderId=id(t.orderId),qty=units(t.qty);if(qty<=0n)wait('invalid execution quantity');return {tradeId,orderId,qty};
    };
    try{
      if(r.pendingClose||r.lossReduction?.status==='PENDING')wait('an existing close or reduction still needs reconciliation');
      // A late position snapshot may now show the fill. In that case normal
      // reconciliation below must protect it, not retire its journal record.
      await this.refresh({inventory:false,valuation:false});
      if(this.position(r.symbol)){this.unseenFillChecks.delete(r.id);this.flatConfirmations?.delete(r.id);return false;}
      if(order.status!=='FILLED'||order.symbol!==r.symbol||order.clientOrderId!==r.id||order.side!==r.side)wait('entry identity is not confirmed');
      const entryId=id(order.orderId),executed=units(order.executedQty);if(executed<=0n)wait('filled quantity is unavailable');
      const entryRows=await this.api.call('GET','/fapi/v1/userTrades',{symbol:r.symbol,orderId:order.orderId,limit:1000});
      if(!Array.isArray(entryRows)||!entryRows.length||entryRows.length>1000)wait('entry fills are not available yet');
      const entryFills=new Map();let entryTotal=0n;
      for(const t of entryRows){const v=check(t);if(v.orderId!==entryId||t.side!==r.side||entryFills.has(v.tradeId))wait('entry fill identity is inconsistent');entryFills.set(v.tradeId,v.qty);entryTotal+=v.qty;}
      if(entryTotal!==executed)wait('entry fill quantities are still settling');
      const first=[...entryFills.keys()].reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
      let fromId=first,balance=0n,lastTime=0,count=0,proof=null;const matched=new Set(),seen=new Set();
      for(let page=0;page<20&&!proof;page++){
        const chunk=await this.api.call('GET','/fapi/v1/userTrades',{symbol:r.symbol,fromId,limit:1000});
        if(!Array.isArray(chunk)||chunk.length>1000)wait('execution history is incomplete');
        const rows=chunk.map(t=>({t,...check(t)})).sort((a,b)=>BigInt(a.tradeId)<BigInt(b.tradeId)?-1:1);
        let largest=BigInt(fromId)-1n;
        for(const v of rows){
          const {t,tradeId,orderId,qty}=v;
          if(BigInt(tradeId)<BigInt(fromId)||seen.has(tradeId)||t.time<lastTime)wait('execution history did not advance consistently');
          seen.add(tradeId);largest=BigInt(tradeId);lastTime=t.time;count++;
          if(orderId===entryId){if(t.side!==r.side||entryFills.get(tradeId)!==qty)wait('entry fills do not match the saved order');matched.add(tradeId);}
          else if(t.side===r.side)wait('another entry changed this position; review Binance trade history');
          balance+=t.side==='BUY'?qty:-qty;
          if((r.side==='BUY'&&balance<0n)||(r.side==='SELL'&&balance>0n))wait('position direction changed outside the saved entry');
          if(balance===0n){
            if(matched.size!==entryFills.size||orderId===entryId)wait('complete entry and closing fills are not confirmed');
            proof={kind:'closed-fill-ledger',entryOrderId:entryId,executedQty:String(order.executedQty),firstTradeId:first,closingTradeId:tradeId,closingOrderId:orderId,closedAt:t.time,tradeCount:count};break;
          }
        }
        if(proof)break;
        if(chunk.length<1000){
          proof=await this.confirmUnseenFlat(r,order,{firstTradeId:first,tradeCount:count,matchedEntryFills:matched.size,expectedEntryFills:entryFills.size});
          if(!proof){this.unseenFillChecks.delete(r.id);return false;}break;
        }
        if(largest<BigInt(fromId))wait('execution history pagination is incomplete');fromId=(largest+1n).toString();
      }
      if(!proof)wait('execution history exceeds the verification limit');
      // Recheck AFTER either proof, including an account cross-check for the
      // missing-history path. Recovery never replays the old entry.
      const finalReadStartedAt=Date.now();
      const [,orders,algos]=await Promise.all([this.refresh({inventory:false,valuation:false}),this.api.call('GET','/fapi/v1/openOrders',{symbol:r.symbol}),this.api.call('GET','/fapi/v1/openAlgoOrders',{symbol:r.symbol})]);
      if(Date.now()-finalReadStartedAt>15000)wait('final position/order confirmation took too long; retrying');
      if(this.position(r.symbol)){this.unseenFillChecks.delete(r.id);this.flatConfirmations?.delete(r.id);return false;}
      const liveRecovery=proof.kind==='repeated-flat-snapshots';
      if(liveRecovery&&(this.unseenFlatPosition(this.account.positions,r.symbol)||this.unseenFlatPosition(this.positions,r.symbol)))wait('account and position snapshots disagree');
      if(!Array.isArray(orders)||!Array.isArray(algos))wait('fresh order inventory is unavailable');
      if(orders.length||algos.length)wait('Binance still reports open orders on this symbol');
      this.orders=this.orders.filter(o=>o.symbol!==r.symbol);this.algos=this.algos.filter(o=>o.symbol!==r.symbol);
      const previous={...r},verifiedAt=Date.now()+this.api.offset;
      r.closedAt=proof.closedAt;r.closeReason=liveRecovery?'Repeated live Binance checks confirm no position or open orders; closing history remains unconfirmed':'Closed fills verified after the initial open-position snapshot was missed';r.flatRecovery={...proof,verifiedAt};
      r.exits=(r.exits||[]).map(e=>({...e,cancelled:true,confirmed:false,reconciledAt:verifiedAt,recoveryReason:liveRecovery?'Repeated flat Binance snapshots and no open orders confirmed':'Closed fills and no open Binance orders confirmed'}));
      try{this.save();}catch(error){for(const key of Object.keys(r))delete r[key];Object.assign(r,previous);throw error;}
      this.unseenFillChecks.delete(r.id);this.flatConfirmations?.delete(r.id);this.event(r.symbol+(liveRecovery?' verified flat twice; saved entry archived with closing history unconfirmed.':' closed trade reconciled from execution history; entry hold can clear after remaining checks.'));return true;
    }catch(error){if(!error.flatConfirmationPending)this.flatConfirmations?.delete(r.id);error.unseenFill=true;if(!error.message.startsWith(r.symbol))error.message=r.symbol+' fill reconciliation: '+error.message;this.unseenFillChecks.set(r.id,{retryAt:Date.now()+5000,error});throw error;}
  }
  exitOwner(e){return this.state.records.find(r=>(r.exits||[]).includes(e));}
  exitReference(e){
    const algoId=algoExchangeId(e.algoId);if(algoId)return {algoId};
    if(validAlgoClientId(e.id))return {clientAlgoId:e.id};
    throw new DemoError('Saved conditional-order client ID is invalid; reconciling with Binance.',-4015);
  }
  rememberExit(e,result){
    const r=this.exitOwner(e),id=algoExchangeId(result?.algoId);
    if(!result||typeof result!=='object'||(result.clientAlgoId!==undefined&&result.clientAlgoId!==e.id)||(r&&result.symbol!==undefined&&result.symbol!==r.symbol)||(id&&algoExchangeId(e.algoId)&&id!==algoExchangeId(e.algoId)))throw new DemoError('Conditional-order identity does not match the saved bot exit');
    if(id&&e.algoId!==id){e.algoId=id;this.save();}return result;
  }
  async recoverExitReference(e){
    const r=this.exitOwner(e);if(!r)throw new DemoError('Conditional order has no matching bot record');
    const rows=await this.api.call('GET','/fapi/v1/openAlgoOrders',{symbol:r.symbol});
    if(!Array.isArray(rows)||rows.some(a=>!a||typeof a.symbol!=='string'||typeof a.clientAlgoId!=='string'||!algoExchangeId(a.algoId)||typeof a.algoStatus!=='string'))throw new DemoError('Incomplete conditional-order inventory; recovery deferred');
    const id=algoExchangeId(e.algoId),matches=rows.filter(a=>a.symbol===r.symbol&&(a.clientAlgoId===e.id||(id&&algoExchangeId(a.algoId)===id)));
    if(matches.length>1)throw new DemoError('Ambiguous conditional-order identity; recovery deferred');
    if(matches.length)return this.rememberExit(e,matches[0]);
    const error=new DemoError('Saved stop is absent from fresh Binance open orders; checking position before cleanup.',-4015);
    error.exitNotOpen=true;error.openAlgos=rows;error.inventoryAt=Date.now();throw error;
  }
  async queryExit(e){
    try{return this.rememberExit(e,await this.api.call('GET','/fapi/v1/algoOrder',this.exitReference(e)));}
    catch(error){if(error.code!==-4015||error.uncertain)throw error;return this.recoverExitReference(e);}
  }
  async retireAbsentExit(r,e,proof,keepId){
    if(!proof.exitNotOpen||Date.now()-proof.inventoryAt>15000)return false;
    const keep=(r.exits||[]).find(x=>x.id===keepId&&!x.cancelled);
    const replacement=keep&&proof.openAlgos.find(a=>a.symbol===r.symbol&&a.clientAlgoId===keep.id&&a.algoStatus==='NEW'&&(a.orderType||a.type)==='STOP_MARKET'&&(a.closePosition===true||a.closePosition==='true')&&a.side===(r.side==='BUY'?'SELL':'BUY'));
    if(replacement){this.rememberExit(keep,replacement);keep.confirmed=true;keep.verifiedAt=Date.now();}
    else{
      if(keepId||!r.observedOpen||r.entryStatus!=='FILLED'||r.pendingClose||r.lossReduction?.status==='PENDING')return false;
      const positions=await this.api.call('GET','/fapi/v3/positionRisk',{symbol:r.symbol});
      if(!Array.isArray(positions)||positions.some(p=>!p||typeof p.symbol!=='string'||!Number.isFinite(Number(p.positionAmt))||p.positionAmt===null||p.positionAmt===undefined||p.positionAmt===''))throw new DemoError('Fresh position check incomplete; stop cleanup deferred');
      if(positions.some(p=>p.symbol===r.symbol&&number(p.positionAmt)!==0))return false;
      this.positions=[...this.positions.filter(p=>p.symbol!==r.symbol),...positions.filter(p=>p.symbol===r.symbol)];this.positionAt=Date.now();
    }
    if(Date.now()-proof.inventoryAt>15000)return false;
    e.cancelled=true;e.confirmed=false;e.reconciledAt=Date.now();e.recoveryReason=keepId?'Absent old exit; replacement verified on Binance':'Absent old exit; Binance position confirmed flat';this.save();
    this.event(r.symbol+' stale stop record reconciled; '+(keepId?'replacement protection verified.':'position is flat.'));return true;
  }
  async sendOnce(path,params,query){
    try{return await this.api.call('POST',path,params);}catch(e){
      if(path==='/fapi/v1/algoOrder'&&e.code===-4015&&!e.uncertain)throw e;
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
      this.entryAccountingReadyAt=Date.now();this.accountingBlock='';this.accountingRetryAt=0;this.accountingUpdateRequired=false;
    }catch(error){
      if([400,404].includes(error.code)){
        this.accountingUpdateRequired=!!error.backendUpdateRequired;
        this.accountingBlock=error.backendUpdateRequired?'Update and restart the laptop connector: fee-history reads are not supported. No entry submitted.':'Binance fee-history read unavailable ('+error.code+'); no entry submitted. Checking again in 30 seconds.';
        this.accountingRetryAt=Date.now()+30000;error.message=this.accountingBlock;error.candidateRead='/fapi/v1/userTrades';
      }
      throw error;
    }
  }
  async entryCommissionRate(symbol){
    if(this.feeCacheAccount!==this.api.key){this.feeCacheAccount=this.api.key;this.entryFeeCache=new Map();}
    this.entryFeeCache??=new Map();const saved=this.entryFeeCache.get(symbol),now=Date.now();
    if(saved?.expires>now)return saved.rate;
    if(saved?.retryAt>now){const error=new DemoError('Commission read unavailable for '+symbol+'; retry in '+Math.ceil((saved.retryAt-now)/1000)+'s. No order submitted.',saved.code);error.candidateRead='/fapi/v1/commissionRate';throw error;}
    try{
      const data=await this.entryRead('/fapi/v1/commissionRate',{symbol}),rate=number(data.takerCommissionRate);
      if(rate<0||rate>.01)throw new DemoError('Unsupported commission rate');
      this.entryFeeCache.set(symbol,{rate,expires:Date.now()+60000});return rate;
    }catch(error){
      if(ACCOUNT_BLOCKS.has(error.code))throw error;
      if(error instanceof DemoError){error.candidateRead='/fapi/v1/commissionRate';this.entryFeeCache.set(symbol,{code:error.code,retryAt:Date.now()+30000});}
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
    this.entryResult={kind:'checks'};
    const recordsBefore=this.state.records.length;
    try{return await this.enterChecked(symbol,signal);}catch(e){
      // Only skip pre-entry failures when no journaled/observed position can be at risk.
      if(this.state.records.length===recordsBefore&&!this.owned(symbol)&&!this.position(symbol)&&(e.candidateRead||(!e.uncertain&&ENTRY_REJECTIONS.has(e.code)))){
        this.entryResult={kind:e.candidateRead?'data-unavailable':'exchange-settings',code:e.code,path:e.candidateRead||e.requestPath||null};
        this.entryOutcome=symbol+' skipped ('+e.code+'): '+e.message+' Scanning continues.';
        this.event(this.entryOutcome);return false;
      }
      throw e;
    }finally{timing.totalMs=Date.now()-timing.startedAt;timing.outcome=this.entryOutcome;const last=timing.stages.at(-1);if(last)last.ms=Date.now()-last.at;const r=this.state.records.findLast(r=>r.symbol===symbol&&r.at>=timing.startedAt+(this.api.offset||0));if(r?.entryEvidence){r.entryEvidence.timing=timing;this.save();}}
  }
  async enterChecked(symbol,signal){
    const progress=reason=>{this.entryOutcome=reason;if(this.entryTiming){const stages=this.entryTiming.stages,previous=stages.at(-1);if(previous)previous.ms=Date.now()-previous.at;stages.push({label:reason,at:Date.now()});}const row=this.scanned.find(s=>s.symbol===symbol);if(row){row.reason=reason;row.entryMs=Date.now()-(this.entryTiming?.startedAt||Date.now());this.notify();}};
    const skip=reason=>{if(this.entryResult?.kind==='checks')this.entryResult={kind:'app-filter'};progress(reason);return false;};
    const skipRead=(reason,error)=>{this.entryResult={kind:'data-unavailable',code:error.code||0,path:error.candidateRead||error.requestPath||null};return skip(reason);};
    this.entryOutcome='Checking entry';
    const epoch=this.stopEpoch;
    const band=this.newRules&&this.bandRules,flexible=band||this.trialActive();
    const trial=this.trialActive()&&signal.oneHourTrial===this.state.oneHourTrial.id;
    if(signal.oneHourTrial&&!trial)return skip('One-hour experiment expired or changed; rechecking normal signals');
    if(!this.auto||this.entryHold||this.startPending||this.state.goalStopAt||(!this.newRules&&this.state.goal&&!this.experimentActive())||this.owned(symbol))return skip('Auto paused, startup checks pending, session goal reached, or already owned');
    if(!signal.qualityConfirmed||![3,5,8].includes(signal.leverage)||!Number.isFinite(signal.stopDistance)||signal.stopDistance<=0)return skip('Signal validation failed');
    if(this.newRules&&!(signal.strength>=1))return skip('Candle momentum agreement is missing');
    const experimental=this.experimentActive()&&signal.experimental===true;
    if(signal.experimental&&!experimental)return skip('Experiment expired; waiting for a normal signal');
    if(band&&!['bollinger-wr','trend-continuation'].includes(signal.setupType))return skip('Old strategy candidate ignored; rechecking Bollinger or trend continuation');
    const lossLimit=band?6:trial?null:this.newRules?5:signal.exitPolicy==='manual-profit-60s-loss'?5:9;
    if(this.state.records.some(r=>r.symbol===symbol&&r.rejected&&r.retryAfter>Date.now()))return skip('Definite Binance rejection: waiting 30 seconds before fresh checks; no filled trade on this attempt');
    if(!trial&&this.state.records.some(r=>!r.rejected&&r.symbol===symbol&&((!this.newRules&&r.signalClose===signal.close)||Date.now()-(r.closedAt||r.at)<(this.newRules&&r.closedAt?600000:60000))))return skip('Already traded this candle or re-entry cooldown (10 minutes after close)');
    if(this.newRules){progress('Checking fee-history support before entry');await this.checkEntryAccounting(symbol);}
    progress('Checking Binance balance, positions and open orders');
    await this.refresh({inventory:!this.newRules,valuation:false});
    if(this.newRules&&await this.enforceSessionGoal())return skip('$'+SESSION_TARGET+' net session target reached');
    if(!this.auto||epoch!==this.stopEpoch||this.position(symbol)||(!this.newRules&&(this.orders.some(o=>o.symbol===symbol)||this.algos.some(o=>o.symbol===symbol))))return skip('Auto changed or existing position/order');
    // Candidate-specific reads prevent stale cached inventories admitting duplicates.
    progress('Checking this symbol for existing orders');
    const inventories=await Promise.all(['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'].map(path=>this.entryRead(path,{symbol})));
    for(const existing of inventories){if(!Array.isArray(existing))throw new DemoError('Order check incomplete');if(existing.length)return skip('Existing Binance order on this symbol');}
    if(Date.now()-this.metaAt>900000)throw new DemoError('Exchange filters expired. Reconnect to refresh.');
    const m=this.meta.get(symbol),lot=m.filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),normal=m.filters.find(f=>f.filterType==='LOT_SIZE'),priceFilter=m.filters.find(f=>f.filterType==='PRICE_FILTER');
    if(!lot||!normal||!priceFilter||!m.orderTypes.includes('MARKET'))return skip('Market-order filters unavailable');
    let momentum,minuteBars,trendBars,directionBaseline,directionCostQuote;
    const hasTrendCandidate=band&&[signal,...(signal.alternatives||[])].some(c=>c.setupType==='trend-continuation');
    if(this.newRules){
      progress('Reading current 1m movement for timeframe-aware entry checks');
      try{
        [minuteBars,directionBaseline,trendBars]=await Promise.all([this.entryRead('/fapi/v1/klines',{symbol,interval:'1m',limit:30},false),band?this.entryRead('/fapi/v1/ticker/bookTicker',{symbol},false):null,hasTrendCandidate?this.entryRead('/fapi/v1/klines',{symbol,interval:'5m',limit:30},false).catch(error=>{if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return null;}):null]);
        breakout(minuteBars,Date.now()+this.api.offset,60000);
      }
      catch(error){if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return skipRead('1m entry check unavailable; scanning continues: '+error.message,error);}
    }
    progress('Checking current entry price');
    const mark=await this.entryRead('/fapi/v1/premiumIndex',{symbol},false);const price=number(mark.markPrice);
    if(Math.abs(Date.now()+this.api.offset-number(mark.time))>15000||(!this.newRules&&Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000))return skip('Signal or mark price became stale');
    if(!this.newRules&&!experimental){const reason=entryPriceReason(price,signal);if(reason)return skip(reason);}
    progress('Checking commission and position size');
    const fee=await this.entryCommissionRate(symbol);
    const originalCandidates=signal;
    let candidateChecks;
    if(this.newRules){
      const selection=selectEntryCandidate(signal,{price,fee,now:Date.now()+this.api.offset,...(band?{intervals:BAND_TIMEFRAMES,maxCandidates:BAND_TIMEFRAMES.length+1}:trial?{intervals:[1,3,5,15,30,60,120,240]}:{}),confirm:candidate=>entryConfirmation(minuteBars,candidate,Date.now()+this.api.offset,trendBars).reason,traded:candidate=>this.state.records.some(r=>!r.rejected&&r.symbol===symbol&&r.signalClose===candidate.close)});
      candidateChecks=selection.checks;const row=this.scanned.find(s=>s.symbol===symbol);if(row)row.entryCandidates=candidateChecks;
      if(!selection.signal)return skip('No entry-ready timeframe: '+candidateChecks.map(c=>(c.setupType==='trend-continuation'?'1m/5m trend':c.minutes+'m')+' '+c.reason).join(' | '));
      signal=selection.signal;progress('Selected '+signal.intervalMs/60000+'m '+(signal.setupType||'breakout')+' after price and commission checks');
      if(row){row.setupType=signal.setupType;row.intervalMs=signal.intervalMs;row.candleClosedAt=signal.close;}
      momentum=entryConfirmation(minuteBars,signal,Date.now()+this.api.offset,trendBars);
      if(momentum.reason)return skip(momentum.reason+'; scanning continues');
    }
    const usdt=this.account.assets.find(a=>a.asset==='USDT');if(!usdt)throw new DemoError('No USDT available for USDT cross-margin trades');
    if(this.state.budgetWalletBaseline===undefined){this.state.budgetWalletBaseline=number(usdt.walletBalance);this.save();}
    const capital=this.budgetStatus();
    const preferredLeverage=this.entryLeverage(signal);
    const step=number(lot.stepSize)>0?lot.stepSize:normal.stepSize;
    const minNotional=number(m.filters.find(f=>f.filterType==='MIN_NOTIONAL')?.notional||m.filters.find(f=>f.filterType==='NOTIONAL')?.minNotional||0);
    const available=number(usdt.availableBalance),marginRoom=Math.max(0,5000-capital.reserved);
    if(flexible&&(!(available>0)||!(marginRoom>0)))return skip('Waiting for available margin; scanning continues');
    if(band&&(available<ENTRY_MARGIN||marginRoom<ENTRY_MARGIN))return skip('Waiting for $300 margin plus fees; no smaller entry will be sent');
    const minimumPlan=(candidate,entryPrice=price,cap=Infinity)=>{
      if(band){
        // Keep the requested margin. Capacity limits may reduce leverage, never size.
        const quantity=rounded(ENTRY_MARGIN*candidate/entryPrice,step,true);
        const qty=number(quantity);return {quantity,qty,notional:qty*entryPrice};
      }
      if(flexible){
        const budget=Math.min(300,marginRoom,available/(1+2*candidate*fee));
        if(!(budget>0))throw new DemoError('No free margin for entry');
        const quantity=rounded(Math.min(budget*candidate/entryPrice,cap/entryPrice,number(lot.maxQty),number(normal.maxQty)),step);
        const qty=number(quantity);return {quantity,qty,notional:qty*entryPrice};
      }
      const quantity=rounded(Math.max(ENTRY_MARGIN*candidate/entryPrice,minNotional/entryPrice,number(lot.minQty),number(normal.minQty)),step,true);
      const qty=number(quantity),notional=qty*entryPrice;
      return {quantity,qty,notional};
    };
    if(this.newRules&&!flexible&&(available<ENTRY_MARGIN||marginRoom<ENTRY_MARGIN))return skip('Waiting for at least $300 free margin plus fees; scanning continues');
    if(this.newRules&&!band&&!trial&&signal.intervalMs===60000&&2*momentum.atr<=3*(2*price*fee))return skip('Recent 1m movement is too small relative to round-trip fees; scanning continues');
    const trialCeiling=flexible?await this.trialLeverageCeiling(symbol):null;
    const leverageCeiling=flexible?trialCeiling:this.newRules?signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset):preferredLeverage;
    let adaptive;
    if(band){
      // Test every integer locally before changing the exchange setting. Keep
      // $300 margin; reduce leverage when fees/spread would consume the stop.
      try{
        const [quote,currentMark]=await Promise.all([this.entryRead('/fapi/v1/ticker/bookTicker',{symbol},false),this.entryRead('/fapi/v1/premiumIndex',{symbol},false)]);
        const quotedPrice=number(signal.side==='BUY'?quote.askPrice:quote.bidPrice);
        const selection=selectEntryCandidate(originalCandidates,{price:quotedPrice,fee,now:Date.now()+this.api.offset,intervals:BAND_TIMEFRAMES,maxCandidates:BAND_TIMEFRAMES.length+1,traded:c=>this.state.records.some(r=>!r.rejected&&r.symbol===symbol&&r.signalClose===c.close),confirm:choice=>{
          const confirmation=entryConfirmation(minuteBars,choice,Date.now()+this.api.offset,trendBars);if(confirmation.reason)return confirmation.reason;
          let reason='No leverage leaves room for the $6 after-fee stop';
          for(let candidate=leverageCeiling;candidate>=1;candidate--){
            const size=minimumPlan(candidate,quotedPrice),check=entryQuoteCheck(quote,currentMark,{symbol,side:choice.side,qty:size.qty,fee,lossLimit,tick:priceFilter.tickSize,now:Date.now()+this.api.offset});
            if(check.reason){reason=check.reason;continue;}
            if(choice.setupType==='trend-continuation'&&Math.max(0,-check.estimatedImmediateExitNet,-check.estimatedMarkNet)+size.qty*confirmation.atr*(1+fee)>lossLimit+1e-8){reason='Trend entry: one recent 1m ATR plus spread and fees exceeds the $6 loss budget';continue;}
            if(check.estimatedRoundTripFees>lossLimit*.5+1e-8){reason='Opening + closing commission would consume more than half the normal loss budget';continue;}
            const targetCosts=bandEntryCosts(choice,quotedPrice,size.qty,fee);if(targetCosts.reason){reason=targetCosts.reason;continue;}
            if(size.notional/candidate>marginRoom+1e-8||size.notional/candidate+check.estimatedRoundTripFees>available+1e-8){reason='Not enough margin plus fees for the full $300 entry';continue;}
            adaptive={leverage:candidate,marginTarget:ENTRY_MARGIN,leverageMode:'highest-fee-compatible',maxLossTarget:6,commissionLossBudget:lossLimit*.5,targetCosts,exchangeCeiling:leverageCeiling,estimatedRoundTripFees:check.estimatedRoundTripFees,estimatedImmediateExitNet:check.estimatedImmediateExitNet};return null;
          }
          return reason;
        }});
        candidateChecks=selection.checks;const row=this.scanned.find(s=>s.symbol===symbol);if(row)row.entryCandidates=candidateChecks;
        if(!selection.signal)return skip('No fee-compatible leverage for $300 margin: '+candidateChecks.map(c=>(c.setupType==='trend-continuation'?'1m/5m trend':c.minutes+'m')+' '+c.reason).join(' | ')+'; scanning continues');
        signal=selection.signal;momentum=entryConfirmation(minuteBars,signal,Date.now()+this.api.offset,trendBars);
        directionCostQuote={...quote};
        if(row){row.setupType=signal.setupType;row.intervalMs=signal.intervalMs;row.candleClosedAt=signal.close;}
        progress('Selected '+signal.intervalMs/60000+'m after full cost and sizing checks');
      }catch(error){if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return skipRead('Leverage cost check unavailable; scanning continues: '+error.message,error);}
    }else adaptive=this.newRules?adaptiveLeveragePlan({price,atr:momentum.atr,fee,lossLimit:ENTRY_VOLATILITY_ALLOWANCE,side:signal.side,tick:priceFilter.tickSize,plan:minimumPlan,maxLeverage:leverageCeiling,requireStop:false,...(trial?{leverageLimit:150,maxFees:2}:{})}):null;
    if(this.newRules&&!adaptive)return skip(trial?'Entry exceeds the volatility or $2 estimated commission allowance even at 1×; scanning continues':'$300 margin exceeds the entry volatility and fee allowance, even at 1×; scanning continues');
    const requestedLeverage=this.newRules?adaptive.leverage:preferredLeverage;
    progress(band?'Checking highest fee-compatible Binance leverage for $300 margin, starting at '+requestedLeverage+'× (exchange ceiling '+leverageCeiling+'×)':'Configuring '+requestedLeverage+'× based on recent volatility, fees and Binance limits');
    try{await this.api.call('POST','/fapi/v1/marginType',{symbol,marginType:'CROSSED'});}catch(e){if(e.code!==-4046)throw e;}
    let leverage,selectedLeverage,minimumSize;
    if(this.newRules){
      // Confirm the maximum accepted leverage that permits the full requested size.
      const tryLeverage=async candidate=>{
        if(!this.auto||epoch!==this.stopEpoch)return false;
        try{
          const response=await this.api.call('POST','/fapi/v1/leverage',{symbol,leverage:candidate});
          if(number(response.leverage)!==candidate||(response.symbol!==undefined&&response.symbol!==symbol))throw new DemoError('Selected leverage not accepted for this symbol');
          if(flexible&&!(number(response.maxNotionalValue)>0))return false;
          const size=minimumPlan(candidate,price,flexible?number(response.maxNotionalValue):Infinity);
          if(flexible&&(size.qty<Math.max(number(lot.minQty),number(normal.minQty))||size.notional<minNotional))return false;
          if(size.notional>number(response.maxNotionalValue)||size.qty>number(lot.maxQty)||size.qty>number(normal.maxQty))return false;
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
        if(band)while(low<=high){const size=minimumPlan(low);if(size.qty>=Math.max(number(lot.minQty),number(normal.minQty))&&size.notional>=minNotional)break;low++;}
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
    if(!selectedLeverage)return skip(band?'No Binance-accepted leverage permits the full $300 order; scanning continues':flexible?'No supported leverage permits the minimum order with available margin; scanning continues':'No supported leverage permits $300 margin; scanning continues');
    let quantity,qty,notional;
    if(this.newRules){
      ({quantity,qty,notional}=minimumSize);
      const margin=notional/selectedLeverage,costs=notional*fee*2;
      if(((!flexible||band)&&margin+1e-8<ENTRY_MARGIN)||margin>marginRoom+1e-8||margin+costs>available+1e-8)return skip('Not enough room for entry margin plus fees at the selected leverage; scanning continues');
      if(band&&costs>=lossLimit)return skip('$300 margin at '+selectedLeverage+'× has estimated round-trip fees $'+costs.toFixed(2)+' that already reach the $6 after-fee loss target; no entry sent');
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
        if(band){
          // Uncached re-read after exchange settings: the candle can reverse or
          // roll over while leverage and margin checks are awaiting responses.
          [minuteBars,trendBars]=await Promise.all([this.entryRead('/fapi/v1/klines',{symbol,interval:'1m',limit:30},false),signal.setupType==='trend-continuation'?this.entryRead('/fapi/v1/klines',{symbol,interval:'5m',limit:30},false):null]);
          momentum=entryConfirmation(minuteBars,signal,Date.now()+this.api.offset,trendBars);
          if(momentum.reason)return skip('Final direction check: '+momentum.reason);
          if(!this.auto||this.entryHold||epoch!==this.stopEpoch||this.controlPending)return skip('Auto or manual action changed during final direction check');
        }
        const [quote,currentMark]=await Promise.all([this.entryRead('/fapi/v1/ticker/bookTicker',{symbol},false),this.entryRead('/fapi/v1/premiumIndex',{symbol},false)]);
        const quotedPrice=number(signal.side==='BUY'?quote.askPrice:quote.bidPrice);
        if(quotedPrice<=0)return skip('Invalid entry quote; scanning continues');
        ({quantity,qty,notional}=minimumPlan(selectedLeverage,quotedPrice,flexible?number(leverage.maxNotionalValue):Infinity));
        quoteEvidence=entryQuoteCheck(quote,currentMark,{symbol,side:signal.side,qty,fee,lossLimit,tick:priceFilter.tickSize,now:Date.now()+this.api.offset});
        if(quoteEvidence.reason)return skip(quoteEvidence.reason+'; scanning continues');
        if(band){
          quoteEvidence.liveDirection=bandEntryLiveCheck(directionBaseline,quote,momentum,{symbol,side:signal.side,tick:priceFilter.tickSize,now:Date.now()+this.api.offset,raw:minuteBars,checkpoint:directionCostQuote});
          const row=this.scanned.find(s=>s.symbol===symbol);if(row)row.entryDirection=quoteEvidence.liveDirection;
          if(quoteEvidence.liveDirection.reason)return skip(quoteEvidence.liveDirection.reason+'; scanning continues');
        }
        if(band&&quoteEvidence.estimatedRoundTripFees>lossLimit*.5+1e-8)return skip('Fresh quote commission exceeds half the normal loss budget; scanning continues');
        quoteEvidence.estimatedLossAtOneAtr=Math.max(0,-quoteEvidence.estimatedImmediateExitNet,-quoteEvidence.estimatedMarkNet)+qty*(momentum?.atr||0)*(1+fee);
        if(band&&signal.setupType==='trend-continuation'&&quoteEvidence.estimatedLossAtOneAtr>lossLimit+1e-8)return skip('Fresh trend exposure exceeds the $6 budget for one 1m ATR plus spread and fees');
        if(!band&&quoteEvidence.estimatedLossAtOneAtr>ENTRY_VOLATILITY_ALLOWANCE+1e-8)return skip('Fresh spread, mark movement and one recent 1m ATR exceed the entry sizing allowance; scanning continues');
        if(trial&&quoteEvidence.estimatedRoundTripFees>2+1e-8)return skip('Fresh quote exceeds the $2 estimated commission allowance; scanning continues');
        const quoteReason=entryPriceReason(quotedPrice,signal,{tolerant:true});if(quoteReason)return skip('Executable quote: '+quoteReason+'; scanning continues');
        if(band){quoteEvidence.targetCosts=bandEntryCosts(signal,quotedPrice,qty,fee);if(quoteEvidence.targetCosts.reason)return skip('Fresh quote: '+quoteEvidence.targetCosts.reason+'; scanning continues');}
        if(qty<Math.max(number(lot.minQty),number(normal.minQty))||notional<minNotional||qty>number(lot.maxQty)||qty>number(normal.maxQty)||notional>number(leverage.maxNotionalValue))return skip('Fresh quote size exceeds Binance order limits; scanning continues');
        const units=qty/number(normal.stepSize);if(!Number.isFinite(units)||Math.abs(units-Math.round(units))>1e-7)return skip('Quantity is not valid for Binance lot step; scanning continues');
        const margin=notional/selectedLeverage;
        if(margin>marginRoom+1e-8||margin+quoteEvidence.estimatedRoundTripFees>available+1e-8)return skip('Fresh quote needs more margin plus fees than available; scanning continues');
      }catch(error){if(error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;return skipRead('Entry quote check unavailable; scanning continues: '+error.message,error);}
    }
    if(!this.auto||this.entryHold||epoch!==this.stopEpoch||this.controlPending||this.shouldScan?.()===false)return skip(this.controlPending?'Manual action queued before entry dispatch':'Auto stopped before entry dispatch');
    if(this.newRules&&!flexible&&selectedLeverage>signalLeverageCeiling(signal,this.marketContext,Date.now()+this.api.offset))return skip('Market context became stale during checks; rechecking before higher leverage');
    if(this.newRules&&(Date.now()+this.api.offset-momentum.closedAt>75000||Date.now()+this.api.offset-signal.close>(signal.intervalMs||300000)+15000))return skip('Entry confirmation became stale during checks; rechecking next scan');
    if(trial&&(!this.trialActive()||signal.oneHourTrial!==this.state.oneHourTrial.id||Date.now()+this.api.offset-signal.close>(signal.intervalMs||60000)+15000))return skip('Experiment expired or candle became stale before entry dispatch');
    if(experimental&&!this.experimentActive())return skip('Experiment expired before order submission');
    if(this.entryLeverage(signal)!==preferredLeverage)return skip('50× window expired during checks; next scan uses adaptive leverage');
    const id='bd1_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
    const r={id,entryAppVersion:APP_VERSION,symbol,side:signal.side,quantity,fee,tick:priceFilter.tickSize,at:Date.now()+this.api.offset,signalClose:signal.close,signal,rulesVersion:this.newRules?8:1,experimentUntil:experimental?this.experimentUntil:null,leverage:selectedLeverage,lossLimit,takeProfit:null,exitPolicy:this.newRules?'net-trailing':signal.exitPolicy,exits:[],protected:false,exitsReady:false};
    if(trial){r.oneHourTrial={...this.state.oneHourTrial};r.rulesVersion=9;r.exitPolicy='trial-net-trailing';r.lossLimit=1;}
    if(band){r.rulesVersion=12;r.exitPolicy='stepped-net-trailing';r.lossLimit=6;r.maxLossLimit=12;r.trailPeak=null;r.profitFloor=null;if(signal.setupType==='bollinger-wr')r.bandTargets={middle:signal.bands.middle,outer:signal.bands.outerTarget,stage:'middle',closedAt:signal.close,intervalMs:signal.intervalMs};else r.trendTargets={referenceTarget:signal.referenceTarget,referenceAtr:signal.referenceAtr,closedAt:signal.close,note:signal.referenceNote};}
    r.estimatedEntryMargin=notional/selectedLeverage;
    if(this.newRules)r.entryEvidence={setupType:signal.setupType,oneMinute:momentum,candidateChecks,...quoteEvidence,requestedLeverage,selectedLeverage,adaptiveSizing:{...adaptive,leverageCeiling},marketContext:this.marketContext||null,marketSource:signal.marketSource||{type:'full-market'}};
    r.sizingNote='Entry margin ≈ $'+(notional/selectedLeverage).toFixed(2)+' · estimated round-trip commission $'+(notional*fee*2).toFixed(2)+' · $300 target margin; adaptive leverage up to 10× based on candle agreement, BTC market context, 1m volatility, fees and exchange limits; trailing net profit from $2; trim 25% at -$3; close at -$5; market fill margin may differ';
    if(trial)r.sizingNote='One-hour experiment · margin ≈ $'+r.estimatedEntryMargin.toFixed(2)+' · '+selectedLeverage+'× · any negative estimated total net closes immediately when detected; fees alone can cause closure · net pullback floors $2 / $4 / $8 / $10 / +$5';
    if(band)r.sizingNote=(signal.setupType==='trend-continuation'?'1m / 5m trend continuation':signal.intervalMs/60000+'m Bollinger / Williams %R')+' · margin ≈ $'+r.estimatedEntryMargin.toFixed(2)+' · '+selectedLeverage+'× · $300 margin target; highest fee-compatible Binance leverage · $6 normal after-fee loss / $12 backup targets · after-fee profit pullbacks $5 / $8 / $11 / +$3';
    this.state.records.push(r);this.save(); // Journal before dispatch; never duplicate an uncertain entry.
    progress('Submitting demo order');
    try{const order=await this.sendOnce('/fapi/v1/order',{symbol,side:r.side,positionSide:'BOTH',type:'MARKET',quantity,newClientOrderId:id,newOrderRespType:'RESULT'},()=>this.queryEntry(r));r.orderId=order.orderId;r.entryStatus=order.status;this.save();
      // Install protection directly from a confirmed fill before slower balance reads.
      if(order.status==='FILLED'&&Number(order.avgPrice)>0&&Number(order.executedQty)>0){
        const filled={entryPrice:order.avgPrice,positionAmt:r.side==='BUY'?order.executedQty:String(-Number(order.executedQty)),markPrice:order.avgPrice};r.entry=Number(order.avgPrice);r.filledQty=Number(order.executedQty);this.save();
        try{
          if(band){await this.ensureExit(r,filled,'sl6',-6);r.exitsReady=!r.closedAt;r.protected=!r.closedAt;}
          else if(trial){await this.reconcileTrialExits(r,filled);}
          else if(this.newRules){await this.ensureExit(r,filled,'sl5',-5);r.exitsReady=!r.closedAt;r.protected=!r.closedAt;}
          else if(!this.exitsSuspended(r)){await this.ensureExit(r,filled,r.rulesVersion===5?'sl20':r.rulesVersion===4?'sl4m':r.rulesVersion===3?'sl8':r.rulesVersion===2?'sl4':'sl',-(r.lossLimit??9));if(!r.closedAt&&!['manual-profit','manual-profit-60s-loss'].includes(r.exitPolicy))await this.ensureExit(r,filled,'tp',40);r.protected=!r.closedAt;}
          this.save();
        }
        catch(e){r.protectionError={at:Date.now()+this.api.offset,code:e.code||0,message:e.message};this.save();this.holdEntries('Protection failed immediately after fill. '+e.message);if(!r.closedAt)await this.close(symbol,'Protection failure');throw e;}
      }
    }
    catch(e){
      if(!e.uncertain&&!r.entryStatus){
        r.rejected=true;r.rejectionCode=e.code;r.retryAfter=Date.now()+30000;this.entryResult={kind:'exchange-rejected',code:e.code,path:'/fapi/v1/order'};this.save();
        if(ENTRY_REJECTIONS.has(e.code)){
          this.event(symbol+' entry rejected ('+e.code+'); scanning continues.');
          return skip('Binance rejected entry ('+e.code+'); continuing other coins');
        }
      }
      this.holdEntries(e.message);throw e;
    }
    await this.refresh();await this.reconcile();this.entryResult={kind:'order-submitted',status:r.entryStatus};this.entryOutcome=r.closedAt?'Entry closed during exit checks':'Entry submitted; status '+r.entryStatus;this.event(symbol+(this.exitsSuspended(r)?' demo entry submitted; automatic exits SUSPENDED until experiment expiry.':' demo entry submitted; confirmed fills and automatic exit policy shown below.'));
  }
  async cancelExits(r,keepId=null){
    for(const e of r.exits||[]){
      if(e.cancelled||e.id===keepId)continue;
      for(let attempt=0;attempt<2;attempt++){
        try{await this.api.call('DELETE','/fapi/v1/algoOrder',this.exitReference(e));e.cancelled=true;e.confirmed=false;this.save();break;}
        catch(error){
          let found;
          try{found=await this.queryExit(e);}
          catch(queryError){
            if([-2011,-2013].includes(queryError.code)&&!queryError.uncertain)found={algoStatus:'NOT_FOUND'};
            else if(await this.retireAbsentExit(r,e,queryError,keepId))break;
            else throw queryError;
          }
          if(['CANCELED','CANCELLED','FINISHED','EXPIRED','REJECTED','NOT_FOUND'].includes(found.algoStatus)){e.cancelled=true;e.confirmed=false;this.save();break;}
          // Retry only this definite identifier rejection, using the exchange ID
          // recovered by an exact match. Never repeat an ambiguous cancel write.
          if(attempt===0&&error.code===-4015&&!error.uncertain&&algoExchangeId(e.algoId))continue;
          throw error;
        }
      }
    }
  }
  async ensureExit(r,p,kind,target,replace=false){
    let e=replace?null:r.exits.findLast(e=>e.kind===kind&&!e.cancelled);
    if(e){
      if(this.newRules&&e.confirmed&&Date.now()-(e.verifiedAt||0)<15000)return;
      let q;try{q=await this.queryExit(e);}catch(error){if([-4015,-2011,-2013].includes(error.code)&&!error.uncertain){e.confirmed=false;this.save();}throw error;}
      if(q.algoStatus==='NEW'){e.confirmed=true;e.verifiedAt=Date.now();this.save();return;}
      e.confirmed=false;if(['CANCELED','CANCELLED','EXPIRED','REJECTED'].includes(q.algoStatus))e.cancelled=true;this.save();throw new DemoError(r.symbol+' protective '+kind+' is '+q.algoStatus+'; checking position.');
    }
    const triggerPrice=exitPrice(number(p.entryPrice),Math.abs(number(p.positionAmt)),r.fee,target,r.side,r.tick);
    const takeProfit=kind==='tp'||kind==='tp20';
    const mark=number(p.markPrice);if(takeProfit?(r.side==='BUY'?mark>=+triggerPrice:mark<=+triggerPrice):(r.side==='BUY'?mark<=+triggerPrice:mark>=+triggerPrice)){await this.close(r.symbol,kind+' threshold reached');return;}
    // A fixed-length, independently journaled ID cannot overflow Binance's
    // 36-character limit after long legacy IDs or repeated stop replacements.
    e={id:'bdx_'+crypto.randomUUID().replaceAll('-','').slice(0,24),kind,triggerPrice,confirmed:false};r.exits.push(e);this.save();
    let result;try{result=await this.sendOnce('/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:r.symbol,side:r.side==='BUY'?'SELL':'BUY',positionSide:'BOTH',type:takeProfit?'TAKE_PROFIT_MARKET':'STOP_MARKET',closePosition:'true',triggerPrice,workingType:'MARK_PRICE',priceProtect:'false',clientAlgoId:e.id},()=>this.queryExit(e));}catch(error){if(!error.uncertain){e.cancelled=true;this.save();}throw error;}
    this.rememberExit(e,result);if(result.algoStatus!=='NEW')throw new DemoError('Protection was not confirmed NEW');
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
    const qty=Math.abs(Number(p.positionAmt)),entry=Number(p.entryPrice),ledger=r.tradeAccounting,limit=this.bandRules?12:r.oneHourTrial?1:5,kind=this.bandRules?'sl12':r.oneHourTrial?'sl1':'sl5';
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
  migrateStepExits(r){
    if(r.rulesVersion===12&&r.exitPolicy==='stepped-net-trailing')return;
    r.previousExitPolicy={rulesVersion:r.rulesVersion,exitPolicy:r.exitPolicy,trailPeak:r.trailPeak??null,profitFloor:r.profitFloor??null};
    r.rulesVersion=12;r.lossLimit=6;r.maxLossLimit=12;r.exitPolicy='stepped-net-trailing';
    r.profitFloor=null;r.trailPeak=null;r.lossSince=null;r.lossRecovery=null;r.tradeAccounting=null;r.exitPolicyAt=Date.now()+this.api.offset;this.save();
  }
  updateStepTrail(r,net){
    if(!Number.isFinite(net))throw new DemoError('Invalid after-fee profit estimate');
    r.trailPeak=Math.max(Number.isFinite(r.trailPeak)?r.trailPeak:-Infinity,net);
    const floor=steppedProfitFloor(r.trailPeak);
    r.profitFloor=Number.isFinite(r.profitFloor)?Math.max(r.profitFloor,floor??-Infinity):floor;this.save();
    return Number.isFinite(r.profitFloor)&&net<=r.profitFloor;
  }
  async supportsLossRecovery(r,net){
    const now=()=>Date.now()+this.api.offset;
    const record=(allowed,reason,evidence={})=>{r.lossRecovery={allowed,reason,checkedAt:now(),net,...evidence};this.save();return allowed;};
    if(net<=-12)return record(false,'$12 after-fee loss target reached; no recovery extension');
    if(net>-6)return record(false,'Below the $6 loss threshold; recovery extension not needed');
    try{
      const [minute,five]=await Promise.all([this.scanBars(r.symbol,'1m',30),this.scanBars(r.symbol,'5m',30)]);
      const check=entryMomentum(minute,r.side,now()),last=five.filter(b=>number(b[6])<now()).at(-1);
      const evidence={minuteClosedAt:check.closedAt,fiveClosedAt:last?number(last[6]):null,candleClose:check.close,atr:check.atr};
      if(!Number.isFinite(check.closedAt)||check.closedAt<(r.openedAt||r.at))return record(false,'No supporting completed 1m candle since entry',evidence);
      if(!recoverySignal(minute,five,r.side,now()))return record(false,'Fresh 1m/5m trend and candle strength do not support recovery',evidence);
      const quote=r.closingEstimate,sign=r.side==='BUY'?1:-1;
      if(!quote||now()-quote.at>5000||!Number.isFinite(quote.price)||!(check.atr>0)||sign*(quote.price-check.close)<-.25*check.atr)return record(false,'Current executable price no longer supports the recovery candle',evidence);
      return record(true,'Fresh 1m/5m trend and strong 1m candle support recovery; not a guarantee',evidence);
    }catch(error){return record(false,'Recovery evidence unavailable: '+error.message);}
  }
  async reviewEarlyLoss(r){
    const now=()=>Date.now()+this.api.offset,quote=r.closingEstimate;
    const record=(decision,momentum=null)=>{r.earlyLossReview={...decision,momentum,checkedAt:now(),net:quote?.net,price:quote?.price};this.save();return decision.exit;};
    if(!quote)return record({exit:false,reason:'Closing estimate unavailable'});
    // Keep independent observations; a second read in the same second cannot
    // fabricate three ticks. Restarted or resized positions cannot reuse old data.
    const samples=(r.earlyLossQuotes||[]).filter(q=>q.at<=now()&&now()-q.at<=15000&&q.entry===Number(r.entry)&&q.quantity===quote.quantity);
    if(!samples.length||quote.at-samples.at(-1).at>=1000)samples.push({at:quote.at,price:quote.price,entry:Number(r.entry),quantity:quote.quantity});
    r.earlyLossQuotes=samples.slice(-3);
    let decision=earlyLossDecision(r,quote,now(),r.earlyLossQuotes);
    if(decision.exit||quote.net>-2||quote.net<=-6||quote.gross>=0)return record(decision);
    let momentum=null;
    try{
      const raw=await this.scanBars(r.symbol,'1m',30);
      momentum=entryMomentum(raw,r.side,now());
      decision=earlyLossDecision(r,quote,now(),r.earlyLossQuotes,momentum);
    }catch(error){
      record({exit:false,reason:'Early-exit evidence unavailable: '+error.message});
      if(ACCOUNT_BLOCKS.has(error.code)||error.uncertain)throw error;
      return false;
    }
    return record(decision,momentum);
  }
  async reconcileBandExits(r,p){
    this.migrateStepExits(r);
    r.sizingNote='Net profit pullbacks $5 / $8 / $11 / +$3 · $2–$6 early loss exit on confirmed adverse movement · normal after-fee loss exit $6; fresh recovery evidence required to hold toward $12 · $12 Binance backup · no loss timer or partial reduction';
    try{
      const net=await this.closingEstimate(r,p),pullback=this.updateStepTrail(r,net);
      if(pullback||net<=-6){await this.close(r.symbol,pullback?'Stepped net profit pullback':'Adaptive net loss',{stepProfit:pullback,adaptiveLoss:!pullback});if(r.closedAt||r.pendingClose)return;}
      else if(r.lossRecovery){r.lossRecovery=null;this.save();}
      await this.ensureLossStop(r,p);
      if(!r.closedAt&&!r.pendingClose&&net<0&&net>-6&&!pullback&&await this.reviewEarlyLoss(r))await this.close(r.symbol,'Early adverse-move exit',{earlyLoss:true});
    }catch(error){
      r.estimateError=error.message;r.netEstimate=null;r.closingEstimate=null;this.save();
      if(!r.closedAt&&!r.pendingClose&&!r.exits?.some(e=>e.kind==='sl12'&&e.confirmed&&!e.cancelled)){
        try{await this.ensureLossStop(r,p);}catch(protectionError){this.holdEntries('Cannot confirm $12 backup loss protection on '+r.symbol);await this.close(r.symbol,'Loss protection failure');throw protectionError;}
      }
      if(error.uncertain||r.pendingClose||r.lossReduction?.status==='PENDING'||ACCOUNT_BLOCKS.has(error.code)||[418,429].includes(error.code))throw error;
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
    const oldAutomaticReason=['Experiment negative net','Experiment profit pullback','$5 net trade loss','Net profit trailing pullback','$2 net trade loss','sl2 threshold reached','$3 net trade loss','sl3 threshold reached','$6 net trade loss','sl6 threshold reached','Bollinger middle target','Bollinger outer target','Bollinger middle-band pullback'].includes(reason);
    const earlyRequested=options.earlyLoss||reason==='Early adverse-move exit';
    const stepAutomatic=this.bandRules&&(earlyRequested||options.stepProfit||options.adaptiveLoss||options.bandLoss||options.bandProfit||oldAutomaticReason||['Stepped net profit pullback','Adaptive net loss','$12 net trade loss'].includes(reason));
    if(stepAutomatic){
      this.migrateStepExits(r);
      let net=await this.closingEstimate(r,p,{forceAccounting:true});
      if(this.updateStepTrail(r,net))reason='Stepped net profit pullback';
      else if(net<=-12){await this.supportsLossRecovery(r,net);reason='$12 net trade loss';}
      else if(net<=-6){
        const supported=await this.supportsLossRecovery(r,net);
        // Recovery reads can take time. Requote before the close so a recovered
        // position or a newly raised profit floor is not judged by an old price.
        net=await this.closingEstimate(r,p);
        if(this.updateStepTrail(r,net))reason='Stepped net profit pullback';
        else if(net<=-12){await this.supportsLossRecovery(r,net);reason='$12 net trade loss';}
        else if(net>-6){r.lossRecovery=null;this.save();return false;}
        else{
          const evidence=r.lossRecovery,sign=r.side==='BUY'?1:-1;
          if(supported&&Date.now()+this.api.offset-evidence.checkedAt<=5000&&sign*(r.closingEstimate.price-evidence.candleClose)>=-.25*evidence.atr)return false;
          if(supported){evidence.allowed=false;evidence.reason='Fresh closing quote no longer supports recovery';this.save();}
          reason='$6 net trade loss';
        }
      }else if(earlyRequested){
        // Revalidate against fresh fees, position size and executable price.
        // Normal $6/$12 and armed profit exits above always take precedence.
        const review=r.earlyLossReview,now=Date.now()+this.api.offset;
        const decision=review&&now-review.checkedAt>=0&&now-review.checkedAt<=10000?earlyLossDecision(r,r.closingEstimate,now,r.earlyLossQuotes,review.momentum):{exit:false,reason:'Early-exit evidence expired; wait for a fresh review'};
        r.earlyLossReview={...review,...decision,checkedAt:now,net,price:r.closingEstimate.price};this.save();
        if(!decision.exit)return false;
        reason='Early adverse-move exit';
      }else return false;
    }else if(r.oneHourTrial&&(options.trialExit||['Experiment negative net','Experiment profit pullback'].includes(reason))){
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
    const failures=[];
    for(const r of this.active()){
      try{
        delete r.reconcileError;
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
        this.holdEntries('Entry status unavailable; protecting observed position.');
        order={status:'UNKNOWN',orderId:r.orderId};
      }
      if(order.orderId!=null&&r.orderId!=null&&String(order.orderId)!==String(r.orderId))throw new DemoError(r.symbol+' entry order ID changed; reconciliation required');
      r.orderId=order.orderId;r.entryStatus=order.status;
      if(['NEW','PARTIALLY_FILLED'].includes(order.status)){this.holdEntries('Entry not fully settled; cancelling remainder.');await this.api.call('DELETE','/fapi/v1/order',{symbol:r.symbol,origClientOrderId:r.id});await this.refresh();}
      let p=this.position(r.symbol);
      if(!p&&!r.observedOpen&&order.status==='FILLED'){
        if(await this.recoverUnseenFill(r,order))continue;
        p=this.position(r.symbol);
      }
      if(!p){if(r.observedOpen||(['CANCELED','EXPIRED','REJECTED'].includes(order.status)&&Number(order.executedQty)===0)){await this.cancelExits(r);r.closedAt=Date.now()+this.api.offset;this.save();continue;}throw new DemoError(r.symbol+' entry awaiting position confirmation; no new orders');}
      if((number(p.positionAmt)>0)!==(r.side==='BUY'))throw new DemoError('Position direction changed outside bot');
      this.unseenFillChecks?.delete(r.id);
      this.flatConfirmations?.delete(r.id);
      r.openedAt=r.openedAt||Number(order.updateTime)||r.at;r.observedOpen=true;r.entry=number(p.entryPrice);r.filledQty=Math.abs(number(p.positionAmt));
      if(r.pendingClose){await this.close(r.symbol,r.closeReason);continue;}
      if(this.exitsSuspended(r)){r.netEstimate=number(p.unRealizedProfit)-r.fee*r.filledQty*(r.entry+number(p.markPrice));r.protected=false;this.save();continue;}
      if(this.newRules){if(this.bandRules)await this.reconcileBandExits(r,p);else if(r.oneHourTrial)await this.reconcileTrialExits(r,p);else await this.reconcileCurrentExits(r,p);continue;}
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
        this.holdEntries('Protection problem on '+r.symbol+'. Attempting reduce-only close.');
        // Never continue opening positions after a failed protective order.
        try{await this.close(r.symbol,'Protection failure');}catch(closeError){throw new DemoError('URGENT: '+r.symbol+' requires review in Binance Demo. '+closeError.message);}
        throw e;
      }
      }catch(error){
        if(!this.bandRules)throw error;
        if(!error.flatConfirmationPending)this.flatConfirmations?.delete(r.id);
        failures.push(error);r.reconcileError={at:Date.now(),message:error.message};this.save();
        if(ACCOUNT_BLOCKS.has(error.code))break;
      }
    }
    if(failures.length)throw failures[0];
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
  async bandCandles(symbol,minutes,controller,datasets=new Map()){
    if(!BAND_TIMEFRAMES.includes(minutes))throw new DemoError('Unsupported Bollinger timeframe');
    const interval=minutes===5||minutes>10?'5m':'1m',limit=interval==='5m'?300:250;
    // Share two native datasets across all 14 independently evaluated frames.
    // Cache failures for this scan too, avoiding repeated calls to a failing read.
    if(!datasets.has(interval))datasets.set(interval,this.scanBars(symbol,interval,limit,controller));
    const raw=await datasets.get(interval),now=Date.now()+this.api.offset;
    return minutes===1||minutes===5?raw:minutes<=10?aggregateMinutes(raw,now,minutes):aggregateFiveMinuteBars(raw,now,minutes);
  }
  async scanRiskCheck({session=true}={}){
    if(!this.connected||!this.tradingReady||!this.active().length||Date.now()-(this.positionAt||0)<this.exitPollMs())return;
    const positions=await this.api.call('GET','/fapi/v3/positionRisk');
    if(!Array.isArray(positions))throw new DemoError('Invalid position snapshot during scan');
    for(const p of positions){number(p.positionAmt);number(p.entryPrice);number(p.markPrice);number(p.unRealizedProfit);if(number(p.positionAmt)!==0&&p.positionSide!=='BOTH')throw new DemoError('Hedge position detected');}
    this.positions=positions;this.positionAt=Date.now();this.notify();
    await this.reconcile();this.lastRiskCheck=Date.now();
    if(session&&!(this.retryAt>Date.now())){await this.ensureIncomeFresh(5000);await this.enforceSessionGoal();}
  }
  async refreshMovers(){
    if(!this.newRules||!this.meta.size||Date.now()-(this.moversCheckedAt||0)<60000)return;
    this.moversCheckedAt=Date.now();
    try{
      const rows=await this.api.call('GET','/fapi/v1/ticker/24hr',{},false);
      if(!Array.isArray(rows))throw new DemoError('Invalid movers response');
      const eligible=new Set(this.symbols),now=Date.now()+this.api.offset;
      const valid=rows.filter(x=>eligible.has(x.symbol)&&this.meta.has(x.symbol)&&Number.isFinite(Number(x.priceChangePercent))&&Number(x.lastPrice)>0&&Number(x.quoteVolume)>0&&Number.isFinite(Number(x.closeTime))&&Math.abs(now-Number(x.closeTime))<600000);
      const gainers=valid.filter(x=>Number(x.priceChangePercent)>0).sort((a,b)=>Number(b.priceChangePercent)-Number(a.priceChangePercent)).slice(0,this.bandRules?20:10);
      const losers=valid.filter(x=>Number(x.priceChangePercent)<0).sort((a,b)=>Number(a.priceChangePercent)-Number(b.priceChangePercent)).slice(0,this.bandRules?20:10);
      this.movers=[];for(let i=0;i<(this.bandRules?20:10);i++){if(gainers[i])this.movers.push({symbol:gainers[i].symbol,side:'BUY',change:Number(gainers[i].priceChangePercent)});if(losers[i])this.movers.push({symbol:losers[i].symbol,side:'SELL',change:Number(losers[i].priceChangePercent)});}
      this.moversAt=Date.now();this.moversNote=this.movers.length?'Futures 24h gainers → BUY; losers → SELL · refreshed '+new Date(this.moversAt).toLocaleTimeString():this.bandRules?'No fresh eligible movers; waiting for the next ranking refresh':'No fresh eligible movers; scanning all markets';
    }catch(error){this.movers=[];this.moversNote=(this.bandRules?'Movers unavailable; retrying ranking refresh. ':'Movers unavailable; full-market scan continues. ')+error.message;if([-1003,429,418].includes(error.code))throw error;}
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
    if(this.newRules&&this.bandRules){
      const startedAt=Date.now(),checks=[],candidates=[],datasets=new Map();
      if(mover)for(const minutes of BAND_TIMEFRAMES){
        if(controller?.signal.aborted||epoch!==this.stopEpoch||!this.auto)throw new DemoError('Scan read cancelled');
        let reason,signal=null,dataError=false;
        try{
          const raw=await this.bandCandles(symbol,minutes,controller,datasets);
          signal=bollingerSetup(raw,mover.side,Date.now()+this.api.offset,r=>reason=r,minutes*60000);
        }catch(error){
          if(controller?.signal.aborted||epoch!==this.stopEpoch||!this.auto||error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;
          dataError=true;reason='Candle data unavailable: '+error.message;
        }
        if(signal){signal.marketSource={type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change};candidates.push(signal);}
        checks.push({minutes,setupType:'bollinger-wr',side:signal?.side||'WAIT',reason:signal?'Band rebound confirmed · Williams %R '+signal.bands.wr.toFixed(1):reason,dataError});
      }
      if(mover){
        let reason,trend=null,dataError=false;
        try{
          const [minute,five]=await Promise.all([this.bandCandles(symbol,1,controller,datasets),this.bandCandles(symbol,5,controller,datasets)]);
          trend=trendContinuationSetup(minute,five,mover.side,Date.now()+this.api.offset,r=>reason=r);
        }catch(error){
          if(controller?.signal.aborted||epoch!==this.stopEpoch||!this.auto||error.uncertain||ACCOUNT_BLOCKS.has(error.code))throw error;
          dataError=true;reason='Trend candle data unavailable: '+error.message;
        }
        if(trend){trend.marketSource={type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change};candidates.push(trend);}
        checks.push({minutes:1,setupType:'trend-continuation',side:trend?.side||'WAIT',reason:trend?'Closed 1m and 5m trends agree; continuation candidate':reason,dataError});
      }
      if(controller?.signal.aborted||epoch!==this.stopEpoch||!this.auto)throw new DemoError('Scan read cancelled');
      const signal=candidates.length?{...candidates[0],alternatives:candidates.slice(1)}:null;
      const reason=!mover?'Not in the current futures gainers/losers list':signal?'Qualified '+candidates.map(c=>c.setupType==='trend-continuation'?'1m/5m trend continuation':c.intervalMs/60000+'m band rebound').join(' / '):'Trend: '+checks.at(-1).reason+' | '+checks.slice(0,2).map(c=>c.minutes+'m band: '+c.reason).join(' | ')+' · expand for all checks';
      return {symbol,mover,signal,reason,foundCandidate:!!signal,hasDataError:checks.some(c=>c.dataError),intervalMs:signal?.intervalMs||60000,scanMs:Date.now()-startedAt,candleClosedAt:signal?.close||null,checks};
    }
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
        const confirmation=this.newRules&&minutes>5?bars:trend,confirmationMs=this.newRules&&minutes>5?minutes*60000:300000;
        if(candidate)qualified=qualifySetup(candidate,bars,confirmation,Date.now()+this.api.offset,r=>reason=r,confirmationMs);
        if(!qualified&&this.newRules)qualified=momentumSetup(bars,confirmation,Date.now()+this.api.offset,minutes*60000,r=>reason=r,confirmationMs);
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
      const confirmation=minutes>5?raw:trend,confirmationMs=minutes>5?ms:300000;
      let reason='No confirmed setup',signal=momentumSetup(raw,confirmation,now,ms,r=>reason=r,confirmationMs);
      if(!signal){const candidate=breakout(raw,now,ms);if(candidate)signal=qualifySetup(candidate,raw,confirmation,now,r=>reason=r,confirmationMs);}
      if(signal&&mover&&signal.side!==mover.side){reason='Mover direction and candle setup disagree';signal=null;}
      checks.push({minutes,side:signal?.side||'WAIT',reason:signal?'Momentum/breakout setup confirmed':reason});
      if(signal)candidates.push({...signal,intervalMs:ms,oneHourTrial:trialId,marketSource:mover?{type:mover.side==='BUY'?'gainer':'loser',change24h:mover.change}:{type:'full-market'}});
    }
    const first=candidates[0],signal=first?{...first,alternatives:candidates.slice(1).filter(s=>s.side===first.side)}:null;
    return {symbol,mover,signal,foundCandidate:!!signal,intervalMs:signal?.intervalMs||60000,reason:checks.slice(0,3).map(c=>c.minutes+'m: '+c.reason).join(' | ')||'Experiment hour ended',scanMs:Date.now()-startedAt,candleClosedAt:signal?.close||null,checks};
  }
  async scan(){
    if(!this.auto||this.entryHold||!this.symbols.length||this.shouldScan?.()===false)return;
    const epoch=this.stopEpoch;this.lastScan=Date.now();const startedAt=Date.now();
    await this.refreshMovers();if(!(this.newRules&&this.bandRules)&&!this.trialActive())await this.refreshMarketContext();
    this.rechecks=this.rechecks||new Map();
    const due=[...this.rechecks].filter(([symbol,v])=>this.symbols.includes(symbol)&&!this.owned(symbol)&&Date.now()-v.seen<300000&&Date.now()-v.checked>=30000).sort((a,b)=>a[1].checked-b[1].checked).slice(0,4).map(([symbol])=>symbol);
    const priority=new Map(),movers=(this.movers||[]).filter(m=>this.symbols.includes(m.symbol)&&!this.owned(m.symbol));
    const moverBySymbol=new Map(movers.map(m=>[m.symbol,m]));
    this.moverCursor=this.moverCursor||0;
    for(let i=0;i<Math.min(8,movers.length);i++){const mover=movers[this.moverCursor++%movers.length];priority.set(mover.symbol,mover);}
    const batch=[...new Set([...priority.keys(),...due.filter(symbol=>!(this.newRules&&this.bandRules)||moverBySymbol.has(symbol))])];
    if(!(this.newRules&&this.bandRules))for(let i=0;i<Math.min(priority.size?4:12,this.symbols.length);i++){const symbol=this.symbols[this.cursor++%this.symbols.length];if(!batch.includes(symbol))batch.push(symbol);}
    for(const [symbol,v] of this.rechecks)if(Date.now()-v.seen>=300000)this.rechecks.delete(symbol);
    const controller=new AbortController();this.scanController=controller;
    const pending=new Map();let next=0,completed=0,errors=0;
    this.scanStats={startedAt,concurrency:3,planned:batch.length,completed:0,dataErrors:0};
    const launch=()=>{
      while(pending.size<3&&next<batch.length&&this.auto&&!this.entryHold&&epoch===this.stopEpoch&&!this.controlPending){
        const symbol=batch[next++];if(this.owned(symbol))continue;
        const request=this.scanCandidate(symbol,moverBySymbol.get(symbol),epoch,controller).then(value=>({symbol,value}),error=>({symbol,error}));
        pending.set(symbol,request);
      }
    };
    try{
      launch();
      while(pending.size&&this.auto&&!this.entryHold&&epoch===this.stopEpoch&&!this.controlPending){
        await this.scanRiskCheck();
        if(!this.auto||this.entryHold||epoch!==this.stopEpoch||this.controlPending)break;
        let timer;const result=await Promise.race([...pending.values(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);clearTimeout(timer);
        if(!result)continue;
        pending.delete(result.symbol);launch();
        if(!this.auto||this.entryHold||epoch!==this.stopEpoch||this.controlPending)break;
        const {symbol,error}=result;
        if(error&&[401,403,418,429,451,-1003].includes(error.code))throw error;
        const value=result.value||{symbol,reason:'Market data unavailable; continuing other coins: '+error.message,scanMs:0};
        const {mover,signal,reason,foundCandidate,intervalMs,scanMs,candleClosedAt,checks}=value;
        if(error||value.hasDataError)errors++;
        if(foundCandidate)this.rechecks.set(symbol,{seen:Date.now(),checked:Date.now()});else if(this.rechecks.has(symbol))this.rechecks.get(symbol).checked=Date.now();
        this.scanChecked=(this.scanChecked||0)+1;completed++;
        this.scanStats={startedAt,concurrency:3,planned:batch.length,completed,dataErrors:errors,elapsedMs:Date.now()-startedAt};
        this.scanned=this.scanned.filter(s=>s.symbol!==symbol);
        const row={symbol,source:mover?(mover.side==='BUY'?'Gainer ':'Loser ')+mover.change.toFixed(2)+'%':'Full-market / recheck',phase:error?'Data error':signal?'Entry checks':value.hasDataError?'Data error':'Signal rules',reason:signal?'Confirmed '+(intervalMs/60000)+'m '+(signal.setupType||'breakout')+'; checking entry':reason,setupType:signal?.setupType||'breakout',side:signal?.side||'WAIT',strength:signal?.strength,leverage:signal&&!this.newRules?this.entryLeverage(signal):undefined,at:Date.now(),scanMs,candleClosedAt,checks};
        this.scanned.unshift(row);this.scanned=this.scanned.slice(0,30);this.notify();
        if(signal&&this.auto&&!this.entryHold&&epoch===this.stopEpoch&&!this.controlPending){
          try{
            await this.ensureIncomeFresh();if(this.newRules&&await this.enforceSessionGoal())return;
            if(!this.newRules&&!this.experimentActive()&&this.sessionNet()>=SESSION_TARGET){this.state.goal=true;row.reason='Session goal reached; new entries paused';this.pause('Session goal reached');this.save();return;}
            await this.enter(symbol,signal);row.reason=this.entryOutcome;row.entryResult=this.entryResult;
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
    if(!this.bandRules&&this.active().some(r=>r.pendingClose||r.lossReduction?.status==='PENDING'||!r.entryStatus||!['FILLED','CANCELED','EXPIRED','REJECTED'].includes(r.entryStatus)))return false;
    const limited=[418,429,-1003,-1015].includes(error.code);
    const delay=limited?60000:Math.min(60000,5000*2**Math.min(this.retryAttempt||0,4));
    this.retryLimited=limited;this.retryPath=error.requestPath;this.retryAttempt=(this.retryAttempt||0)+1;this.retryAt=Math.max(Date.now()+delay,this.api.blockUntil||0);
    this.block='Temporary read failure: '+error.message+' Auto will recheck connection and positions before resuming entries.';
    if(this.bandRules)this.entryHold=this.block;
    this.event(this.block);return true;
  }
  async tick(){
    if(!this.connected||this.busy||this.controlPending)return;
    this.expireTrial();
    if(this.api.blockUntil>Date.now()){
      if(this.auto){this.retryAt=Math.max(this.retryAt||0,this.api.blockUntil);this.retryLimited=true;this.block='Binance request cooldown; entries and position reads resume when the exchange permits requests.';}
      this.notify();return;
    }
    if((!this.bandRules&&this.retryAt>Date.now())||(this.retryLimited&&this.retryAt>Date.now())){this.notify();return;}
    this.busy=true;
    try{
      if(this.bandRules){
        await this.scanRiskCheck({session:false});
        if(this.retryAt>Date.now())return;
      }
      if(this.startPending){await this.start();if(this.startPending||!this.auto)return;}
      this.expireTrial();this.syncDaily();
      if(!this.tradingReady){await this.refreshBalance();return;}
      if(Date.now()-(this.lastFullCheck||0)>=this.exitPollMs()||this.state.dayOpenPnl===null){await this.refresh();this.lastFullCheck=Date.now();}
      await this.reconcile();this.lastRiskCheck=Date.now();
      if(this.newRules){await this.ensureIncomeFresh(5000);if(await this.enforceSessionGoal()){await this.updateIncome();return;}}
      else if(Date.now()-this.lastIncome>15000)await this.updateIncome();
      if(this.auto&&Date.now()-this.metaAt>600000){const info=await this.api.call('GET','/fapi/v1/exchangeInfo',{},false);if(!Array.isArray(info.symbols))throw new DemoError('Invalid exchange metadata');for(const symbol of [...this.meta.keys()]){const m=info.symbols.find(x=>x.symbol===symbol&&x.status==='TRADING');if(m)this.meta.set(symbol,m);else this.meta.delete(symbol);}this.symbols=[...this.meta.keys()].sort();this.metaAt=Date.now();}
      if(!this.newRules&&!this.experimentActive()&&this.state.startedAt&&this.sessionNet()>=SESSION_TARGET){this.state.goal=true;this.pause('Session $'+SESSION_TARGET+' goal reached; new entries paused. Manual-profit positions remain open.');this.save();}
      if(!this.newRules&&!this.experimentActive()&&this.state.goal)for(const r of this.active().filter(r=>r.exitPolicy!=='manual-profit-60s-loss'))await this.close(r.symbol,'$'+SESSION_TARGET+' session goal');
      if(this.bandRules){
        const reason=this.entrySafetyReason();
        if(reason){this.holdEntries(reason);return;}
        this.entryHold='';
      }else{
      if(this.positions.some(p=>number(p.positionAmt)!==0&&!this.owned(p.symbol)))this.pause('Unmanaged position detected; auto entries stopped.');
      if(this.orders.some(o=>!this.active().some(r=>r.id===o.clientOrderId||r.pendingClose===o.clientOrderId||r.lossReduction?.id===o.clientOrderId))||this.algos.some(a=>!this.state.records.some(r=>(r.exits||[]).some(e=>e.id===a.clientAlgoId))))this.pause('Unmanaged orders detected; auto entries stopped.');
      }
      if(this.auto&&Date.now()-this.lastScan>=1000)await this.scan();
      await this.scanRiskCheck();await this.reviewContinuation();
      this.block='';this.retryAt=0;this.retryLimited=false;this.retryAttempt=0;
    }catch(e){this.handleRunError(e);}finally{this.busy=false;this.notify();}
  }
}
if(typeof module!=='undefined')module.exports={trendContinuationSetup,bandEntryLiveCheck,SESSION_TARGET,earlyLossDecision,bandEntryCosts,steppedProfitFloor,APP_VERSION,BAND_TIMEFRAMES,bollingerSnapshot,bollingerSetup,trialProfitFloor,netProfitFloor,entryConfirmation,selectEntryCandidate,ENTRY_MARGIN,MAX_ENTRY_LEVERAGE,candleTrend,momentumSetup,entryPriceReason,signalLeverageCeiling,DemoAPI,DemoEngine,DemoError,rounded,breakout,twoMinuteBars,aggregateMinutes,aggregateFiveMinuteBars,qualifySetup,experimentSignal,profitFloor,recoverySignal,entryMomentum,entryQuoteCheck,adaptiveLeveragePlan,exitPrice,combinedValue,DEMO_BASE};



