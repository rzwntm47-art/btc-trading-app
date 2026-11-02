const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DemoEngine,DemoError,bollingerSnapshot,bollingerSetup}=require('./engine.js');
const {fixture,entryBars,closingQuote,setTradeNet,reductionPosts,symbol}=require('./test-fixture.cjs');
function bandBars(side='BUY',at=Date.now()){
 const end=Math.floor(at/300000)*300000;
 const rows=Array.from({length:30},(_,i)=>{const c=105+.2*Math.sin(i);return [end-(30-i)*300000,c-.1,c+.3,c-.3,c,100,end-(29-i)*300000-1];});
 Object.assign(rows.at(-2),{1:104,2:104.3,3:95,4:96});Object.assign(rows.at(-1),{1:96,2:100.3,3:95.8,4:100});
 return side==='BUY'?rows:rows.map(b=>[b[0],200-b[1],200-b[3],200-b[2],200-b[4],b[5],b[6]]);
}
function bandFixture(side='BUY'){
 const f=fixture();f.e.newRules=true;f.e.bandRules=true;f.signal.side=side;const base=f.api.call;
 f.api.call=async(m,p,q={},s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.00001'}:p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:20,notionalCap:1000000,notionalFloor:0}]}:p==='/fapi/v1/klines'?(q.interval==='5m'?bandBars(side):entryBars(side)):base(m,p,q,s);
 f.signal=bollingerSetup(bandBars(side),side,Date.now());assert.ok(f.signal,'synthetic band rebound');return f;
}
async function opened(side='BUY'){const f=bandFixture(side);await f.e.enter(symbol,f.signal);assert.ok(f.e.owned(symbol),'entry remains open after fees');return f;}
function entries(f){return f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order'&&!c.p.reduceOnly);}
function atPrice(f,price){closingQuote(f,price);f.position.markPrice=String(price);f.position.unRealizedProfit=String((price-100)*Math.abs(Number(f.position.positionAmt))*(f.signal.side==='BUY'?1:-1));}
test('defaults select permanent Bollinger targets and supersede the old one-hour experiment',async()=>{
 const e=new DemoEngine({offset:0},null,()=>{});assert.equal(e.entryPolicy.lossLimit,6);assert.equal(e.entryPolicy.profitExit,'bollinger-targets');assert.equal(e.entryPolicy.maxLeverage,150);
 e.state.oneHourTrial={startedAt:Date.now(),until:Date.now()+3600000};assert.equal(e.trialActive(),false);await assert.rejects(()=>e.startTrial(),/replaced/);
});
test('Bollinger uses 20-close population deviation and Williams uses the last 14 highs/lows',()=>{
 const raw=bandBars(),b=bollingerSnapshot(raw,Date.now()),last=raw.slice(-20),mean=last.reduce((n,c)=>n+c[4],0)/20,sd=Math.sqrt(last.reduce((n,c)=>n+(c[4]-mean)**2,0)/20);
 assert.ok(Math.abs(b.middle-mean)<1e-10);assert.ok(Math.abs(b.upper-(mean+2*sd))<1e-10);
 const hi=Math.max(...raw.slice(-14).map(c=>c[2])),lo=Math.min(...raw.slice(-14).map(c=>c[3]));assert.ok(Math.abs(b.wr-(-100*(hi-raw.at(-1)[4])/(hi-lo)))<1e-10);
});
for(const side of ['BUY','SELL']){
 test(side+' requires band touch, WR extreme and a closed reversal candle',()=>{
  const raw=bandBars(side),s=bollingerSetup(raw,side,Date.now());assert.equal(s.side,side);assert.equal(s.intervalMs,300000);assert.equal(s.setupType,'bollinger-wr');assert.equal(bollingerSetup(raw,side==='BUY'?'SELL':'BUY',Date.now()),null);
  const flat=structuredClone(raw);flat.at(-1)[1]=flat.at(-1)[4];assert.equal(bollingerSetup(flat,side,Date.now()),null);
  const stale=bandBars(side,Date.now()-900000);assert.equal(bollingerSetup(stale,side,Date.now()),null);
  const malformed=structuredClone(raw);malformed[10][0]++;assert.throws(()=>bollingerSetup(malformed,side,Date.now()),/candles/);
 });
 test(side+' enters with fixed $300 margin, verified $6 exchange stop and no fee-only close',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);assert.equal(entries(f).length,1);assert.equal(r.rulesVersion,11);assert.equal(r.lossLimit,6);assert.equal(r.exitPolicy,'bollinger-targets');assert.ok(Math.abs(r.estimatedEntryMargin-300)<1e-8);assert.ok(r.leverage===20);
  assert.ok(r.entryEvidence.estimatedRoundTripFees<=1);assert.ok(r.exits.some(e=>e.kind==='sl6'&&e.confirmed&&!e.cancelled));assert.ok(r.netEstimate<0&&r.netEstimate>-6);assert.equal(reductionPosts(f).length,0);assert.equal(f.e.auto,true);
 });
 test(side+' closes the full remaining position at $6 total net loss without stopping Auto',async()=>{
  const f=await opened(side),r=f.e.owned(symbol);setTradeNet(f,-5.9);await f.e.reconcile();assert.ok(!r.closedAt);setTradeNet(f,-6.01);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$6 net trade loss');assert.equal(reductionPosts(f).length,0);assert.equal(f.e.auto,true);
 });
 test(side+' closes a reached middle target with positive after-fee P&L',async()=>{
  const f=await opened(side),r=f.e.owned(symbol),sign=side==='BUY'?1:-1;atPrice(f,r.bandTargets.middle+.02*sign);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Bollinger middle target');assert.ok(f.trades.reduce((s,t)=>s+Number(t.realizedPnl)-Number(t.commission),0)>0);
 });
 test(side+' extends only with fresh momentum then closes before the outer band',async()=>{
  const f=await opened(side),r=f.e.owned(symbol),sign=side==='BUY'?1:-1;
  const rows=bandBars(side),nextClose=r.bandTargets.middle+.02*sign;
  Object.assign(rows.at(-1),{4:nextClose,2:Math.max(rows.at(-1)[2],nextClose+.05),3:Math.min(rows.at(-1)[3],nextClose-.05)});
  const middle=bollingerSnapshot(rows,Date.now()).middle;atPrice(f,middle+.02*sign);
  r.at-=120000;const base=f.api.call;f.api.call=async(m,p,q={},s)=>{
   if(p==='/fapi/v1/klines'&&q.interval==='1m'){const minute=entryBars(side),delta=middle+.02*sign-100;return minute.map(b=>[b[0],b[1]+delta,b[2]+delta,b[3]+delta,b[4]+delta,b[5],b[6]]);}
   if(p==='/fapi/v1/klines'&&q.interval==='5m')return rows;return base(m,p,q,s);
  };
  f.e.candleCache=new Map();await f.e.reconcile();assert.ok(!r.closedAt);assert.equal(r.bandTargets.stage,'outer');atPrice(f,r.bandTargets.outer+.02*sign);await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Bollinger outer target');
 });
}
test('a profit close rechecks fees and refuses a nonpositive net even with gross green',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.bandTargets.middle=100.01;setTradeNet(f,-.01);assert.equal(await f.e.close(symbol,'Bollinger middle target',{bandProfit:'middle'}),false);assert.ok(f.position);
});
test('a recovered loss is rechecked before submission and is not closed at the old estimate',async()=>{
 const f=await opened();setTradeNet(f,-1);assert.equal(await f.e.close(symbol,'$6 net trade loss',{bandLoss:true}),false);assert.ok(f.position);
});
test('legacy immediate-negative reason cannot close a recovered position after the strategy update',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.oneHourTrial={id:'old'};setTradeNet(f,-.1);assert.equal(await f.e.close(symbol,'Experiment negative net',{trialExit:true}),false);assert.ok(f.position);
});
test('scanner uses only fresh listed movers and ignores unrelated all-market symbols',async()=>{
 const f=bandFixture();f.e.symbols=[symbol,'OTHERUSDT'];f.e.movers=[{symbol,side:'BUY',change:12}];f.e.moversCheckedAt=Date.now();const out=await f.e.scanCandidate(symbol,f.e.movers[0],f.e.stopEpoch);assert.ok(out.signal);const no=await f.e.scanCandidate('OTHERUSDT',null,f.e.stopEpoch);assert.equal(no.signal,null);
 let scanned=[];f.e.scanCandidate=async(s)=>{scanned.push(s);return {symbol:s,signal:null,reason:'waiting'};};await f.e.scan();await f.e.scan();assert.deepEqual(scanned,[symbol,symbol]);assert.equal(f.e.auto,true);
});
test('entry skips a middle-band target already reached and keeps scanning',async()=>{
 const f=bandFixture();f.signal.bands.middle=99.9;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);
});
test('an unavailable old connector still blocks entries rather than inventing fees',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/userTrades'){const e=new DemoError('old',400);e.backendUpdateRequired=true;throw e;}return base(m,p,q,s);};await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.accountingUpdateRequired,true);assert.equal(f.e.auto,true);
});
test('forming candle cannot alter the closed-bar bands or signal',()=>{
 const raw=bandBars(),before=bollingerSnapshot(raw,Date.now()),t=raw.at(-1)[6]+1;
 raw.push([t,100,101,99,100,100,t+299999]);assert.deepEqual(bollingerSnapshot(raw,Date.now()),before);
});
test('migration replaces a legacy stop before cancellation and retains a fee-only losing position',async()=>{
 const f=await opened(),r=f.e.owned(symbol),old=r.exits.at(-1),base=f.api.call;
 const oldAlgo=f.algos.get(old.id);f.algos.delete(old.id);old.id=old.id.replace('_sl6','_sl1');oldAlgo.clientAlgoId=old.id;f.algos.set(old.id,oldAlgo);old.kind='sl1';r.rulesVersion=9;r.exitPolicy='trial-net-trailing';r.oneHourTrial={id:'old'};r.lossLimit=1;setTradeNet(f,-.1);
 const writes=[];f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/algoOrder'&&['POST','DELETE'].includes(m))writes.push({m,q});return base(m,p,q,s);};
 await f.e.reconcile();assert.equal(r.rulesVersion,11);assert.equal(r.lossLimit,6);assert.ok(!r.closedAt);assert.equal(writes[0].m,'POST');assert.ok(writes.some(x=>x.m==='DELETE'&&x.q.clientAlgoId===old.id));assert.ok(r.exits.some(x=>x.kind==='sl6'&&x.confirmed&&!x.cancelled));assert.equal(reductionPosts(f).length,0);
});
test('booked manual partial losses count toward the same $6 limit',async()=>{
 const f=await opened(),r=f.e.owned(symbol);setTradeNet(f,-1.8);await f.api.call('POST','/fapi/v1/order',{symbol,side:'SELL',quantity:String(Number(f.position.positionAmt)/2),reduceOnly:'true',newClientOrderId:'manual-partial'});r.tradeAccounting=null;
 setTradeNet(f,-6.01);await f.e.refresh();await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'$6 net trade loss');assert.ok(f.trades.some(t=>Number(t.realizedPnl)<0));assert.equal(reductionPosts(f).length,0);
});
for(const side of ['BUY','SELL'])test(side+' continuation closes on a positive-net middle-band pullback',async()=>{
 const f=await opened(side),r=f.e.owned(symbol),sign=side==='BUY'?1:-1;r.bandTargets.stage='outer';const targets={...r.bandTargets};atPrice(f,targets.middle-.01*sign);
 await f.e.reconcile();assert.ok(r.closedAt);assert.equal(r.closeReason,'Bollinger middle-band pullback');assert.equal(r.bandTargets.middle,targets.middle);
});
test('insufficient target room after fees skips the order without stopping Auto',async()=>{
 const f=bandFixture();f.signal.bands.middle=100.001;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/commission/);assert.equal(f.e.auto,true);
});
test('unsupported leverage bracket read still uses a confirmed exchange setting',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverageBracket')throw new DemoError('unsupported',400);if(p==='/fapi/v1/leverage'&&q.leverage>1)throw new DemoError('not allowed',-4028);return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.equal(f.e.owned(symbol).leverage,1);assert.equal(f.e.auto,true);
});
test('definite exchange rejection continues scanning without resubmitting that order',async()=>{
 const f=bandFixture(),base=f.api.call;let submissions=0;f.api.call=async(m,p,q,s)=>{if(m==='POST'&&p==='/fapi/v1/order'&&!q.reduceOnly){submissions++;throw new DemoError('position cap',-2027);}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(submissions,1);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/continuing other coins/);
});
test('ambiguous accepted entry is reconciled once and protected by sl6',async()=>{
 const f=bandFixture();f.unknownEntry=true;await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,1);assert.ok(f.e.owned(symbol).exits.some(e=>e.kind==='sl6'&&e.confirmed));
});
test('a rejected loss stop closes the exposure and pauses new entries',async()=>{
 const f=bandFixture();f.failProtection=true;await assert.rejects(()=>f.e.enter(symbol,f.signal));assert.equal(f.e.auto,false);assert.equal(f.position,null);
});
test('zero available margin does not stop Auto or submit orders',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const result=await base(m,p,q,s);if(p==='/fapi/v3/account')result.assets[0].availableBalance='0';return result;};await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);
});
test('missing movers are explained without claiming a full-market fallback',async()=>{
 const f=bandFixture(),base=f.api.call;f.e.symbols=[symbol];f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/24hr'?[]:base(m,p,q,s);await f.e.refreshMovers();assert.match(f.e.moversNote,/waiting for the next ranking/);assert.deepEqual(f.e.movers,[]);
});
for(const [reason,target] of [['Bollinger middle target',-.1],['$6 net trade loss',-1]])test('cancelled pending '+reason+' rechecks its conditions instead of blindly closing',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.pendingClose='bd1_pending_c';r.closeReason=reason;f.orders.set(r.pendingClose,{status:'CANCELED',executedQty:'0'});setTradeNet(f,target);
 const before=f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order').length;await f.e.reconcile();assert.ok(f.position);assert.ok(!r.pendingClose);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/order').length,before);
});
for(const cap of [10,20,50,125])for(const side of ['BUY','SELL'])test(side+' uses $300 margin at the Binance maximum '+cap+'x',async()=>{
 const f=bandFixture(side),base=f.api.call;f.e.meta.get(symbol).filters.find(x=>x.filterType==='PRICE_FILTER').tickSize='.00001';
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:cap,notionalCap:1000000,notionalFloor:0}]}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.leverage,cap);assert.equal(r.estimatedEntryMargin,300);assert.equal(Number(entries(f)[0].p.quantity)*100,300*cap);
 const stop=r.exits.find(x=>x.kind==='sl6'&&!x.cancelled),qty=Number(r.quantity),sign=side==='BUY'?1:-1,net=(Number(stop.triggerPrice)-100)*qty*sign-(100+Number(stop.triggerPrice))*qty*r.fee;assert.ok(net>=-6-1e-7&&net<0);
});
test('capacity reduces leverage to the highest setting fitting $300 instead of shrinking margin',async()=>{
 const f=bandFixture(),base=f.api.call;let setting;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverageBracket')return {symbol,brackets:[{initialLeverage:50,notionalCap:10000,notionalFloor:0}]};if(p==='/fapi/v1/leverage'){setting=q.leverage;return {symbol,leverage:q.leverage,maxNotionalValue:'10000'};}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.leverage,33);assert.equal(setting,33);assert.equal(r.estimatedEntryMargin,300);assert.equal(entries(f).length,1);
});
test('account leverage restriction confirms the highest accepted setting before entry',async()=>{
 const f=bandFixture(),base=f.api.call;let setting;
 f.api.call=async(m,p,q,s)=>{if(p==='/fapi/v1/leverageBracket')return {symbol,brackets:[{initialLeverage:50}]};if(p==='/fapi/v1/leverage'){if(q.leverage>17)throw new DemoError('account limit',-4206);setting=q.leverage;return {symbol,leverage:q.leverage,maxNotionalValue:'1000000'};}return base(m,p,q,s);};
 await f.e.enter(symbol,f.signal);assert.equal(f.e.owned(symbol).leverage,17);assert.equal(setting,17);assert.equal(f.e.owned(symbol).estimatedEntryMargin,300);
});
test('quantity capacity reduces leverage rather than sending a smaller-margin order',async()=>{
 const f=bandFixture(),base=f.api.call;f.e.meta.get(symbol).filters.find(x=>x.filterType==='MARKET_LOT_SIZE').maxQty='120';
 f.api.call=async(m,p,q,s)=>p==='/fapi/v1/leverageBracket'?{symbol,brackets:[{initialLeverage:50}]}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(f.e.owned(symbol).leverage,40);assert.equal(f.e.owned(symbol).estimatedEntryMargin,300);assert.equal(Number(entries(f)[0].p.quantity),120);
});
test('fees consuming $6 skip with explicit reason, without reducing leverage or margin',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.0005'}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.match(f.e.entryOutcome,/\$300 margin at 20×.*fees \$6.00.*\$6/);assert.equal(f.e.auto,true);
 assert.deepEqual(f.calls.filter(c=>c.path==='/fapi/v1/leverage').map(c=>c.p.leverage),[20]);
});
for(const available of [250,300.05])test('available '+available+' cannot shrink the requested $300 plus fees order',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>{const r=await base(m,p,q,s);if(p==='/fapi/v3/account')r.assets[0].availableBalance=String(available);return r;};
 await f.e.enter(symbol,f.signal);assert.equal(entries(f).length,0);assert.equal(f.e.auto,true);assert.match(f.e.entryOutcome,/margin.*fees/);
});
test('quantity rounding targets $300 at the final quote within one exchange lot step',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/ticker/bookTicker'?{symbol,bidPrice:'100.003',askPrice:'100.003',bidQty:'10000',askQty:'10000',time:Date.now()}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.ok(r.estimatedEntryMargin>=300&&r.estimatedEntryMargin<300+.001*100.003/r.leverage);assert.equal(r.leverage,20);
});
test('migration changes $2 backup to $6 without adding margin or changing profit targets',async()=>{
 const f=await opened(),r=f.e.owned(symbol),old=r.exits.at(-1),base=f.api.call;
 const algo=f.algos.get(old.id);f.algos.delete(old.id);old.id=old.id.replace('_sl6','_sl2');algo.clientAlgoId=old.id;f.algos.set(old.id,algo);old.kind='sl2';r.rulesVersion=10;r.lossLimit=2;r.bandTargets.stage='outer';const targets={...r.bandTargets},qty=f.position.positionAmt;
 const before=f.calls.length;await f.e.reconcile();assert.equal(r.rulesVersion,11);assert.equal(r.lossLimit,6);assert.equal(f.position.positionAmt,qty);assert.deepEqual(r.bandTargets,targets);
 const writes=f.calls.slice(before).filter(c=>c.method==='POST'||c.method==='DELETE');assert.equal(writes[0].path,'/fapi/v1/algoOrder');assert.equal(writes[0].method,'POST');assert.ok(writes.some(c=>c.method==='DELETE'&&c.p.clientAlgoId===old.id));assert.ok(!writes.some(c=>['/fapi/v1/order','/fapi/v1/leverage'].includes(c.path)));
});
test('an old cancelled $2 close does not reapply the old loss target',async()=>{
 const f=await opened(),r=f.e.owned(symbol);r.pendingClose='bd1_old_loss_c';r.closeReason='$2 net trade loss';f.orders.set(r.pendingClose,{status:'CANCELED',executedQty:'0'});setTradeNet(f,-2.5);
 await f.e.reconcile();assert.ok(f.position);assert.ok(!r.pendingClose);assert.ok(!r.closedAt);
});
test('the revised $6 target permits an otherwise valid entry with fees above the obsolete $3 target',async()=>{
 const f=bandFixture(),base=f.api.call;f.api.call=async(m,p,q,s)=>p==='/fapi/v1/commissionRate'?{takerCommissionRate:'.0004'}:base(m,p,q,s);
 await f.e.enter(symbol,f.signal);const r=f.e.owned(symbol);assert.ok(r,f.e.entryOutcome);assert.equal(r.lossLimit,6);assert.equal(r.leverage,20);assert.equal(r.estimatedEntryMargin,300);assert.ok(r.entryEvidence.estimatedRoundTripFees>3&&r.entryEvidence.estimatedRoundTripFees<6);assert.ok(!r.closedAt);assert.ok(r.exits.some(x=>x.kind==='sl6'&&x.confirmed));
});
