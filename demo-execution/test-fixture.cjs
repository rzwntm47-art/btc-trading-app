const assert=require('node:assert/strict');
const {DemoEngine,DemoError}=require('./engine.js');
const now=Date.now();
const symbol='BTCUSDT';
function continuationBars(side='BUY',ms=60000,at=Date.now()){
 const bars=entryBars(side,at),end=Math.floor(at/ms)*ms;
 bars.forEach((b,i)=>{b[0]=end-(bars.length-i)*ms;b[6]=b[0]+ms-1;});
 // An earlier wick prevents a 20-candle breakout despite sustained momentum.
 if(side==='BUY')bars[15][2]=105;else bars[15][3]=95;
 return bars;
}
function entryBars(side='BUY',at=Date.now(),scale=1){
 const end=Math.floor(at/60000)*60000,sign=side==='BUY'?1:-1;
 return Array.from({length:30},(_,i)=>{
  const close=100+(i-29)*.15*sign*scale,open=close-.3*sign*scale;
  return [end-(30-i)*60000,open,Math.max(open,close)+.05*scale,Math.min(open,close)-.05*scale,close,20,end-(29-i)*60000-1];
 });
}
function lowVolatility(f){
 f.signal.strength=3;f.e.marketContext={side:f.signal.side,closedAt:Date.now()-1000};
 const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/klines'?entryBars(f.signal.side,Date.now(),.1):p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.00001'}:base(m,p,q,s);
}
function fixture(){
  let position=null,orders=new Map(),algos=new Map(),calls=[],trades=[],fillPrice=100,unknownEntry=false,failProtection=false,failClose=false,entryQuoteReads=0;
  const api={offset:0,call:async(method,path,p={},signed=true)=>{
    calls.push({method,path,p,signed});
    if(path==='/fapi/v3/account'&&!e.owned(symbol))entryQuoteReads=0;
    if(path==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000',marginBalance:'5000'}],positions:position?[{...position,unrealizedProfit:position.unRealizedProfit}]:[]};
    if(path==='/fapi/v3/positionRisk')return position?[position]:[];
    if(path==='/fapi/v1/openOrders')return [];
    if(path==='/fapi/v1/openAlgoOrders')return [...algos.values()].filter(x=>x.algoStatus==='NEW');
    if(path==='/fapi/v1/assetIndex')return [{symbol:'USDTUSD',index:'1',time:Date.now()}];
    if(path==='/fapi/v1/ticker/bookTicker'){
      const baseline=e.newRules&&e.bandRules&&!e.owned(symbol)&&++entryQuoteReads===1,price=baseline?100-(signal.side==='BUY'?1:-1)*.08:100;
      return {symbol,bidPrice:String(price),askPrice:String(price),bidQty:'1000',askQty:'1000',time:Date.now()-(baseline?1000:0)};
    }
    if(path==='/fapi/v1/premiumIndex')return {markPrice:'100',time:Date.now()};
    if(path==='/fapi/v1/klines')return entryBars(signal.side);
    if(path==='/fapi/v1/commissionRate')return {takerCommissionRate:'.0005'};
    if(path==='/fapi/v1/marginType')return {code:200};
    if(path==='/fapi/v1/leverageBracket')return {symbol,brackets:[{initialLeverage:125,notionalCap:1000000,notionalFloor:0}]};
    if(path==='/fapi/v1/leverage')return {leverage:p.leverage,maxNotionalValue:'1000000'};
    if(path==='/fapi/v1/income')return [];
    if(path==='/fapi/v1/userTrades')return trades.filter(t=>(!p.orderId||String(t.orderId)===String(p.orderId))&&(!p.fromId||BigInt(t.id)>=BigInt(p.fromId))).slice(0,p.limit||1000);
    if(path==='/fapi/v1/order'){
      if(method==='GET'){if(!orders.has(p.origClientOrderId))throw new DemoError('not found',-2013);return orders.get(p.origClientOrderId);}
      if(method==='DELETE'){const order=orders.get(p.origClientOrderId);if(order)order.status='CANCELED';return {status:'CANCELED'};}
      if(failClose&&p.reduceOnly)throw new DemoError('unknown close',0,true);
      const o={orderId:orders.size+1,status:'FILLED',clientOrderId:p.newClientOrderId,avgPrice:String(fillPrice),executedQty:p.quantity};orders.set(p.newClientOrderId,o);
      const qty=Number(p.quantity),realized=p.reduceOnly&&position?(fillPrice-Number(position.entryPrice))*Math.min(qty,Math.abs(Number(position.positionAmt)))*(Number(position.positionAmt)>0?1:-1):0;
      trades.push({id:trades.length+1,orderId:o.orderId,symbol,positionSide:'BOTH',side:p.side,qty:p.quantity,price:String(fillPrice),realizedPnl:String(realized),commission:String(qty*fillPrice*(e.owned(symbol)?.fee??.0005)),commissionAsset:'USDT',time:Date.now()+api.offset});
      if(p.reduceOnly){assert.equal(p.reduceOnly,'true');if(position){const before=Math.abs(Number(position.positionAmt)),left=Math.max(0,before-Number(p.quantity)),ratio=left/before;position=left?{...position,positionAmt:String(left*(Number(position.positionAmt)>0?1:-1)),unRealizedProfit:String(Number(position.unRealizedProfit)*ratio),positionInitialMargin:String(Number(position.positionInitialMargin)*ratio)}:null;}}else{position={symbol,positionSide:'BOTH',positionAmt:p.side==='BUY'?p.quantity:String(-p.quantity),entryPrice:'100',markPrice:'100',unRealizedProfit:'0',positionInitialMargin:'100'};if(unknownEntry)throw new DemoError('timeout',0,true);}
      return o;
    }
    if(path==='/fapi/v1/algoOrder'){
      if(p.clientAlgoId!==undefined&&!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(p.clientAlgoId))throw new DemoError('invalid client order ID',-4015);
      const found=p.algoId!==undefined?[...algos.values()].find(a=>String(a.algoId)===String(p.algoId)):algos.get(p.clientAlgoId);
      if(method==='GET'){if(!found)throw new DemoError('missing',-2013);return found;}
      if(method==='DELETE'){if(!found)throw new DemoError('missing',-2013);found.algoStatus='CANCELED';return {algoId:found.algoId,clientAlgoId:found.clientAlgoId,code:200};}
      if(failProtection)throw new DemoError('unsupported',-1111);
      assert.equal(p.closePosition,'true');assert.equal(p.reduceOnly,undefined);assert.equal(p.quantity,undefined);
      const a={...p,algoStatus:'NEW',algoId:algos.size+1};algos.set(p.clientAlgoId,a);return a;
    }
    throw Error('Unmocked '+method+' '+path);
  }};
  let saved=[];const e=new DemoEngine(api,null,s=>saved.push(JSON.parse(JSON.stringify(s))));e.newRules=false;e.bandRules=false;
  // Historical-policy fixtures; small-profit tests explicitly restore current defaults.
  Object.assign(e.entryPolicy,{entryFilters:'full-confirmation',maxCommissionShare:.25,strategies:['bollinger-wr','trend-continuation'],trendTimeframes:[1,5],reentryCooldownMs:600000,sessionExit:'close-bot-positions',maxLeverage:150,leverageMode:'highest-fee-compatible',lossExit:'adaptive-recovery',lossLimit:6,maxLossLimit:12,earlyLossExit:'confirmed-adverse-move',earlyLossMin:2,marginMode:'fixed',trendVolatilityLossLimit:6,minimumNetAtTarget:5,entryDirection:'closed-1m-and-live-quotes',profitStart:5,profitStep:3,takeProfit:null,profitExit:'stepped-net-trailing'});e.overrideUntil=0;e.experimentUntil=0;
  e.meta.set(symbol,{orderTypes:['MARKET'],filters:[{filterType:'MARKET_LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100000'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]});e.metaAt=Date.now();e.connected=true;e.auto=true;e.state.startedAt=now-1000;
  const signal={qualityConfirmed:true,strength:2,leverage:3,stopDistance:3,side:'BUY',close:now-1000,price:100,high:99,low:90,atr:2};
  e.marketContext={side:'BUY',closedAt:Date.now()-1000};e.marketCheckedAt=Date.now();
  return {e,api,signal,calls,saved,orders,algos,trades,set fillPrice(v){fillPrice=v},get position(){return position},set position(p){position=p},set unknownEntry(v){unknownEntry=v},set failProtection(v){failProtection=v},set failClose(v){failClose=v}};
}
function closingQuote(f,price,extra={}){
 f.fillPrice=price;
 const base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:String(price),askPrice:String(price),bidQty:'100000',askQty:'100000',time:Date.now(),...extra}:base(m,p,q,s);
}
function reductionPosts(f){return f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&c.p.newClientOrderId?.endsWith('_r'));}
function setTradeNet(f,target,{mark=true}={}){
 const r=f.e.owned(symbol),p=f.position,qty=Math.abs(Number(p.positionAmt)),sign=r.side==='BUY'?1:-1;
 const booked=f.trades.reduce((sum,t)=>sum+Number(t.realizedPnl)-Number(t.commission),0);
 const price=(target-booked+qty*Number(p.entryPrice)*sign)/(qty*(sign-r.fee));closingQuote(f,price);
 if(mark){p.markPrice=String(price);p.unRealizedProfit=String((price-Number(p.entryPrice))*qty*sign);}
 return price;
}

function v181Policy(){return {...new DemoEngine({offset:0}).entryPolicy,entryFilters:'full-confirmation',entryDirection:'closed-candle-stable-quotes',maxCommissionShare:.25,minimumNetAtTarget:1,strategy:'bollinger-wr-and-trend-continuation',strategies:['bollinger-wr','trend-continuation'],trendTimeframes:[1,5],trendVolatilityLossLimit:1,reentryCooldownMs:600000,lossLimit:.5,maxLossLimit:1,takeProfit:1,profitExit:'small-net-profit',sessionExit:'close-bot-positions'};}
module.exports={v181Policy,fixture,entryBars,continuationBars,lowVolatility,closingQuote,reductionPosts,setTradeNet,now,symbol};

