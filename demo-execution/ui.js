'use strict';
const $=id=>document.getElementById(id);

const VAULT_ID='btc_demo_credentials_encrypted_v1';
const pack=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const unpack=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function vaultKey(password,salt){
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function saveCredentials(value,password){
 if(password.length<8)throw Error('Choose a save password with at least 8 characters.');
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await vaultKey(password,salt);
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value)));
 localStorage.setItem(VAULT_ID,JSON.stringify({v:1,salt:pack(salt),iv:pack(iv),data:pack(data)}));
}
async function readCredentials(password){
 const record=JSON.parse(localStorage.getItem(VAULT_ID)||'null');
 if(!record)throw Error('No saved credentials on this browser yet.');
 const key=await vaultKey(password,unpack(record.salt));
 try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unpack(record.iv)},key,unpack(record.data))));}
 catch{throw Error('Could not unlock saved credentials. Check your save password.');}
}

let engine=null,releaseLock=null,connectionBusy=false;
const money=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
function line(parent,values){const tr=document.createElement('tr');for(const v of values){const td=document.createElement('td');if(v instanceof Node)td.append(v);else td.textContent=String(v??'—');tr.append(td);}parent.append(tr);}
function status(message){$('status').textContent=message;}
let renderPending=false;
function queueRender(){if(renderPending)return;renderPending=true;setTimeout(()=>{renderPending=false;render();},100);}
function render(){
  const e=engine,connected=!!e?.connected;
  $('connect').disabled=connectionBusy||!!e?.api?.key;$('disconnect').disabled=!e?.api?.key||e.busy;
  $('retry').disabled=connectionBusy||!e?.api?.key||e.busy;
  $('start').disabled=!connected||e.controlPending||e.auto||!!e.state.goalStopAt||(!e.newRules&&e.state.goal&&!e.experimentActive());
  $('resetDemo').disabled=!connected||e.controlPending;
  $('copyTradeReport').disabled=!connected||e.controlPending;
  $('stop').disabled=!connected;$('refresh').disabled=!connected||e.controlPending;
  $('again').hidden=!e?.state?.goalStopAt;
  $('again').disabled=!connected||e.busy||!e.state.startedAt||e.active().length>0||e.positions.some(p=>Number(p.positionAmt)!==0);
  $('entryStatus').textContent=e?(e.remote&&e.appVersion!==APP_VERSION?'Laptop engine '+(e.appVersion?'V'+e.appVersion:'version unknown')+' has not loaded the V'+APP_VERSION+' rules. Update/restart the laptop engine. ':'')+e.scanDiagnostics().status:'Disconnected: connect Binance Demo, then Start / Resume Demo.';
  const trial=e?.state?.oneHourTrial,trialActive=!!e?.trialActive();
  $('startTrial').disabled=!connected||!!e.controlPending||trialActive||!!e.state.goalStopAt||(e.remote&&e.appVersion!==APP_VERSION);
  $('endTrial').disabled=!connected||!!e.controlPending||!trialActive;
  const remaining=trialActive?Math.max(0,Math.ceil((trial.until-(Date.now()+(e.api.offset||0)))/1000)):0;
  $('trialStatus').textContent=trialActive?'EXPERIMENT '+(e.auto?'RUNNING':'PAUSED')+' · '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0')+' remaining · ends '+new Date(trial.until).toLocaleTimeString()+' · confirmed setups; Binance-accepted leverage; any negative after-fee estimate closes':trial?'Experiment entry window ended. Normal entries restored; experiment positions retain their recorded exits.':'Not started. Click Start 1-hour experiment when connected.';
  if(!connected)return;
  status((e.auto?(e.retryAt>Date.now()?'AUTO WAITING · automatic retry in '+Math.ceil((e.retryAt-Date.now())/1000)+'s':'AUTO RUNNING · scanning for qualifying signals'):e.tradingReady?'DEMO CONNECTED · AUTO STOPPED':'BALANCE CONNECTED · TRADING NOT READY')+(e.controlPending?' · requested action queued / running':e.busy?' · checking…':'')+(e.block?'\n'+e.block:'')+'\nLast account read: '+new Date(e.accountAt).toLocaleTimeString());
  const policy=e.entryPolicy;
  $('leverageWindow').textContent=policy?'$'+policy.margin+' margin · adaptive leverage up to '+policy.maxLeverage+'× · Cross · 1–60m signals · '+(policy.lossLimit===null?'no stop loss':(policy.lossLimit?'$'+policy.lossLimit:'Recorded')+' planned loss stop')+' · '+(policy.profitExit==='net-trailing'?'net profit floors $2 / $4 / $6 / $8 / $10 / +$5 · 25% trim at -$3, full close at -$5':policy.profitExit==='positive-estimate'?'close positive estimated net · reduce 25% once when negative':policy.profitExit==='fixed'?'$'+policy.takeProfit+' net take-profit':policy.profitExit==='manual'?'manual profit close':'previous profit rules'):'Laptop engine '+(e.appVersion?'V'+e.appVersion:'version unavailable')+' uses previous settings. Update and restart it to apply $300 margin / up to 10×.';
  if(trialActive)$('leverageWindow').textContent='ONE-HOUR EXPERIMENT · up to $300 margin · maximum allowed leverage up to 150× · confirmed momentum/breakout setups · close any negative after-fee estimate · net pullback $2 / $4 / $8 / $10 / +$5 · $100 net session stop';
  const capital=e.budgetStatus();$('budgetValue').textContent='Available demo USDT: $'+money(Number(e.account?.assets.find(a=>a.asset==='USDT')?.availableBalance))+' · Current position margin: $'+money(capital.reserved)+' · $5,000 margin budget · no position-count cap · '+(policy?'$'+policy.margin+' target margin/entry':'Previous engine entry settings; update required')+' · '+(policy?.profitExit==='net-trailing'?'paid commissions + partial results + funding + expected closing fee included':policy?.profitExit==='positive-estimate'?'closing estimates include fees · one 25% loss reduction · no stop loss':policy?.profitExit==='fixed'?'$'+policy.takeProfit+' net profit target includes estimated fees · no stop loss':'fees included in '+(policy?.lossLimit?'$'+policy.lossLimit:'recorded')+' loss target');
  if(trialActive)$('budgetValue').textContent='Available demo USDT: $'+money(Number(e.account?.assets.find(a=>a.asset==='USDT')?.availableBalance))+' · Current position margin: $'+money(capital.reserved)+' · $5,000 margin budget · up to $300 per experiment entry · fees can exceed $1 before the price moves';
  $('combined').textContent=e.balance===null?'Unavailable':e.balance.toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:4});
  if(Number.isFinite(e.balance)&&e.balance>0){try{localStorage.setItem('btc_demo_balance_snapshot_v1',JSON.stringify({value:e.balance,at:e.accountAt,source:'Binance Demo combined margin value',usdtAvailable:Number(e.account?.assets.find(a=>a.asset==='USDT')?.availableBalance)}));}catch{/* Display remains usable if browser storage is unavailable. */}}
  $('balanceNote').textContent='Estimated conversion using Binance Demo asset indices; Binance website valuation may differ.';
  const usdt=e.account?.assets.find(a=>a.asset==='USDT');$('available').textContent=money(Number(usdt?.availableBalance));$('wallet').textContent='USDT wallet: '+money(Number(usdt?.walletBalance));
  const openPnl=e.unrealizedPnl(),snapshotReady=!!e.positionAt;
  $('unrealized').textContent=snapshotReady?money(openPnl):'Awaiting Binance';$('unrealized').className=openPnl<0?'bad':'good';
  $('unrealizedNote').textContent='Open USDT positions only · no fees/history deducted · '+(snapshotReady?'Binance snapshot '+new Date(e.positionAt).toLocaleTimeString()+'; polling can lag the Binance screen':'Awaiting position snapshot');
  $('session').textContent=e.state.startedAt?(e.lastIncome?money(e.sessionNet()):'Syncing income…'):'Not started';$('session').className=e.sessionNet()<0?'bad':'good';
  $('sessionNote').textContent=e.state.startedAt?'Window since '+new Date(e.state.startedAt).toLocaleString()+' · Income snapshot '+(e.lastIncome?new Date(e.lastIncome).toLocaleTimeString():'pending')+(e.state.goalStopAt?' · $100 target reached; '+(policy?.sessionExit==='close-bot-positions'?(e.active().length?'closing bot positions; new entries stopped':'bot positions closed; new entries stopped'):policy?.profitExit==='manual'?'new entries paused; profits close manually':'running laptop engine applies its recorded exit rules'):''):'Starts when you enable auto';
  if(!e.state.goalStopAt&&e.sessionNet()>=100)$('sessionNote').textContent+=' · Checking executable net after closing fees before the $100 stop';
  const audit=e.incomeBreakdown();
  if(e.sessionCloseEstimate)$('sessionNote').textContent+=' · Estimated session net after closing bot positions: $'+money(e.sessionCloseEstimate.net)+' (includes $'+money(e.sessionCloseEstimate.closingFees)+' expected exit fees; checked '+new Date(e.sessionCloseEstimate.at).toLocaleTimeString()+')';
  $('pnlEquation').textContent=e.lastIncome?'Net = booked trading result ('+money(audit.net)+') + unrealized ('+money(openPnl)+') − opening unrealized baseline ('+money(e.newRules?(e.state.dayOpenPnl||0):0)+') = '+money(e.sessionNet()):'Waiting for income history; no net result is claimed yet.';
  $('incomeAudit').textContent=e.lastIncome?'Realized gains: $'+money(audit.gains)+' · Realized losses: $'+money(audit.losses)+' · Commissions: $'+money(audit.commission)+' · Funding: $'+money(audit.funding)+' · Net booked trading result: $'+money(audit.net)+' · Updated '+new Date(e.lastIncome).toLocaleTimeString():'Awaiting Binance income history';
  $('incomeDiagnosis').textContent=!e.lastIncome?'Connect and sync to load actual results.':audit.net<0?(audit.realized<0?'Realized losses exceed realized gains. ':'Realized trading P&L is positive, but costs exceed it. ')+(audit.commission<0?'Commission reduces the wallet result. ':'')+'Review these actual results before changing the strategy.':'Booked trading result is nonnegative for this window. A wallet drop may involve an earlier period, a reset, transfers, or other income types excluded here.';

  const market=e.marketContext;
  $('moversNote').textContent=(e.moversNote||'Loading eligible futures gainers and losers')+' · BTC 5m: '+(market?.side==='BUY'?'up':market?.side==='SELL'?'down':'mixed / unavailable')+' · Gainers/losers are past price changes, not profit predictions';
  const stats=e.scanStats;
  $('scanTiming').textContent=stats?'Last batch: '+stats.completed+'/'+stats.planned+' checks · '+(stats.elapsedMs/1000).toFixed(2)+'s · up to 3 coins checked concurrently · '+stats.dataErrors+' data errors':'Waiting for scan timings';
  $('scanTitle').textContent='Setups · '+e.symbols.length+' markets · '+(e.scanChecked||0)+' checks completed · repeats continuously · cycle '+(Math.floor(e.cursor/Math.max(1,e.symbols.length))+1);$('setups').replaceChildren();
  for(const s of e.scanned)line($('setups'),[s.symbol+(s.source?' · '+s.source:''),s.side==='BUY'?'LONG · '+(s.leverage?s.leverage+'×':'sizing pending')+' — '+s.reason:s.side==='SELL'?'SHORT · '+(s.leverage?s.leverage+'×':'sizing pending')+' — '+s.reason:'WAIT — '+s.reason,new Date(s.at).toLocaleTimeString(),(s.phase||'Check')+' · scan '+((s.scanMs||0)/1000).toFixed(2)+'s'+(Number.isFinite(s.entryMs)?' · entry '+(s.entryMs/1000).toFixed(2)+'s':'')+(s.candleClosedAt?' · candle closed '+new Date(s.candleClosedAt).toLocaleTimeString():'')]);
  if(!e.scanned.length)line($('setups'),[e.auto?'Scanning markets…':'Click Start / Resume Demo to scan','—','—','—']);
  $('positions').replaceChildren();
  const positions=e.positions.filter(p=>Number(p.positionAmt)!==0);
  $('positionsTab').textContent='Positions ('+positions.length+')';
  $('ordersTab').textContent='Open Orders ('+(e.orders.length+e.algos.length)+')';
  $('syncNote').textContent='Positions: '+(e.positionAt?new Date(e.positionAt).toLocaleTimeString():'awaiting sync')+' · Orders: '+(e.ordersAt?new Date(e.ordersAt).toLocaleTimeString():'awaiting sync')+(e.scopedOrders?' · Order list covers tracked/open-position symbols only; each entry checks its own symbol.':'')+' · Position checks target every '+(e.exitPollMs()/1000)+'s, including during scans; network delays and cooldowns can delay updates.';
  const field=(parent,label,value,cls='')=>{const d=document.createElement('div'),l=document.createElement('small'),v=document.createElement('b');l.textContent=label;v.textContent=value;v.className=cls;d.append(l,v);parent.append(d);};
  for(const p of positions){
    const r=e.owned(p.symbol),card=document.createElement('article');card.className='position-card';
    const title=document.createElement('h3');title.textContent=(Number(p.positionAmt)>0?'B · ':'S · ')+p.symbol+' Perp';title.className=Number(p.positionAmt)>0?'good':'bad';card.append(title);
    const grid=document.createElement('div');grid.className='position-grid';
    field(grid,'PNL (USDT)',money(Number(p.unRealizedProfit)),Number(p.unRealizedProfit)<0?'bad pnl':'good pnl');
    field(grid,'Size',String(Math.abs(Number(p.positionAmt))));
    field(grid,'Initial margin (USDT)',p.positionInitialMargin??'—');
    field(grid,'Entry price',p.entryPrice);field(grid,'Mark price',p.markPrice);field(grid,'Liquidation price',p.liquidationPrice??'—');card.append(grid);
    const exits=e.algos.filter(a=>a.symbol===p.symbol),note=document.createElement('small');note.textContent='TP / SL: '+(exits.map(a=>(a.orderType||a.type||'Conditional')+' '+(a.triggerPrice??a.stopPrice??'—')).join(' · ')||'No open conditional orders in last sync');card.append(note);
    if(r&&e.exitsSuspended(r)){const warning=document.createElement('p');warning.textContent='NO AUTOMATIC EXITS during experiment · restore after '+new Date(r.experimentUntil).toLocaleString()+' while app is connected';warning.className='bad';card.append(warning);}
    if(r?.sizingNote){const sizing=document.createElement('p');sizing.textContent=r.sizingNote;card.append(sizing);}
    if(['net-trailing','trial-net-trailing'].includes(r?.exitPolicy)){
      field(grid,'Estimated total trade net (USDT)',money(r.netEstimate),Number.isFinite(r.netEstimate)?(r.netEstimate<0?'bad pnl':'good pnl'):'');
      const target=document.createElement('p');target.textContent='Net profit floor: '+(Number.isFinite(r.profitFloor)?'$'+money(r.profitFloor):'not armed until net exceeds $2')+' · Highest net since this policy: '+money(r.trailPeak)+' · Floors: $2 → $4 → $6 → $8 → $10 → $15 → $20… · Close on pullback; no deliberate profit exit below $2';card.append(target);
      if(r.oneHourTrial)target.textContent='Experiment net profit floor: '+(Number.isFinite(r.profitFloor)?'$'+money(r.profitFloor):'not armed until net exceeds $2')+' · Highest net: '+money(r.trailPeak)+' · Floors $2 → $4 → $8 → $10 → $15 → $20 → +$5';
      const accounting=document.createElement('p'),c=r.closingEstimate;accounting.textContent=c?'Includes paid commission $'+money(c.paidCommission)+' · expected closing fee $'+money(c.closingFee)+' · booked partial P&L '+money(c.realized)+' · funding '+money(c.funding)+' · '+c.source+' at '+new Date(c.at).toLocaleTimeString():'Waiting for matched Binance fills, fees and a fresh closing quote';card.append(accounting);
      const reduction=document.createElement('p'),loss=r.lossReduction;reduction.textContent='At -$3 total trade net: reduce 25% once. At -$5: close this trade’s remainder; other trades continue. '+(loss?'Reduction: '+loss.status+(Number.isFinite(loss.executedQty)?' · '+loss.executedQty+' units closed':'')+(loss.reason?' · '+loss.reason:''):'Reduction not yet used');card.append(reduction);
      if(r.oneHourTrial)reduction.textContent='Experiment loss rule: full close at any negative estimated total net; no timer or 25% trim. Fees can trigger immediate closure. $1 planned exchange backup does not guarantee a $1 loss cap.';
      const note=document.createElement('small');note.textContent='Final fills can differ from estimates. Below $2 after a gap, a profit exit waits for recovery; the -$5 loss exit remains active.'+(r.estimateError?' · Exit check pending: '+r.estimateError:'');if(r.oneHourTrial)note.textContent='Experiment exits stay attached until this position closes, even after the entry hour ends. Network delays and market fills can worsen losses.'+(r.estimateError?' · Exit check pending: '+r.estimateError:'');card.append(note);
    }
    if(r?.exitPolicy==='positive-estimate'){
      field(grid,'Estimated closing net (USDT)',money(r.netEstimate),Number.isFinite(r.netEstimate)?(r.netEstimate<0?'bad pnl':'good pnl'):'');
      const target=document.createElement('p');target.textContent='Close when estimated closing net is positive after estimated opening and closing fees · no $20 cap or pullback · '+(r.closingEstimate?'Quote: '+r.closingEstimate.source+' at '+new Date(r.closingEstimate.at).toLocaleTimeString():'Awaiting a fresh closing quote')+' · Funding and actual fills may change the result';card.append(target);
      const reduction=document.createElement('p'),loss=r.lossReduction;
      reduction.textContent=loss?'One-time 25% loss reduction: '+loss.status+(Number.isFinite(loss.executedQty)?' · '+loss.executedQty+' units closed':'')+(loss.reason?' · '+loss.reason:''):'Loss rule: reduce 25% once when estimated net is negative; fees can trigger this immediately after entry';card.append(reduction);
      const note=document.createElement('small');note.textContent='No stop loss on the remainder · $100 net session target closes all bot positions · These exits require the engine running'+(r.estimateError?' · Exit check pending: '+r.estimateError:'');card.append(note);
    }
    if(r?.exitPolicy==='profit-cap'){const target=document.createElement('p');target.textContent='No stop loss · Auto-close target: $'+(r.takeProfit??20)+' estimated net profit · $100 net session target closes all bot positions · Estimated net: '+(Number.isFinite(r.netEstimate)?'$'+r.netEstimate.toFixed(2):'pending')+' · Manual close remains available';card.append(target);}
    if(['manual-profit','manual-profit-60s-loss'].includes(r?.exitPolicy)&&!e.exitsSuspended(r)){const timer=document.createElement('p');timer.textContent='Loss exit: '+(Number.isFinite(r.lossLimit)?'$'+r.lossLimit:'Recorded target')+' planned net loss · no time limit · '+(r.recoveryNote||'Fixed recorded loss target; no recovery extension');card.append(timer);const review=document.createElement('p');review.textContent=(r.continuation||'Trend review pending for a profitable position')+(r.reviewAt?' · Checked '+new Date(r.reviewAt).toLocaleTimeString():'')+(r.exitPolicy==='manual-profit'?' · Profit close: manual; no profit floor':' · Profit floor: '+(Number.isFinite(r.profitFloor)?'$'+r.profitFloor.toFixed(2):'not active until net profit exceeds $4; smaller gains can return to zero'))+' · Estimated net: '+(Number.isFinite(r.netEstimate)?'$'+r.netEstimate.toFixed(2):'pending')+' · Highest observed net: '+(Number.isFinite(r.peak)?'$'+r.peak.toFixed(2):'pending')+' · Manual close available';card.append(review);}
    const b=document.createElement('button');b.textContent=r?(r.pendingClose?'Close awaiting confirmation':'Close position'):'Manage this position in Binance';b.disabled=e.controlPending||!r;b.onclick=()=>run(()=>e.close(p.symbol));card.append(b);$('positions').append(card);
  }
  if(!positions.length)$('positions').textContent='No open positions in the last Binance snapshot.';
  $('openOrders').replaceChildren();
  for(const o of [...e.orders,...e.algos])line($('openOrders'),[o.symbol+' / '+o.side,o.orderType||o.type||'Conditional',o.triggerPrice??o.stopPrice??o.price??'—',o.closePosition?'Entire position':o.origQty??o.quantity??'—',o.algoStatus||o.status||'Open']);
  if(!$('openOrders').children.length)line($('openOrders'),['No open orders','','','','']);
  $('pending').textContent=e.active().filter(r=>(!(['profit-cap','positive-estimate','net-trailing','trial-net-trailing'].includes(r.exitPolicy)?r.exitsReady:r.protected)&&!e.exitsSuspended(r))||r.pendingClose||r.lossReduction?.status==='PENDING').map(r=>r.symbol+' · '+(r.pendingClose?'close pending':r.lossReduction?.status==='PENDING'?'25% reduction pending':r.entryStatus||'entry unresolved')).join(' | ');
  $('trades').replaceChildren();
  for(const r of [...e.state.records].reverse().slice(0,50)){
    const income=e.income.filter(x=>x.symbol===r.symbol&&Number(x.time)>=r.at&&(!r.closedAt||Number(x.time)<=r.closedAt));
    const pnl=income.reduce((s,x)=>s+Number(x.income),0);
    line($('trades'),[r.symbol,r.rejected?'Rejected':r.closedAt?'Closed':r.entryStatus||'Checking',r.rejected?'—':r.at<e.state.startedAt?'Earlier session':income.length?money(pnl):'Settling']);
  }
  $('assets').replaceChildren();for(const a of e.account?.assets||[])if(Number(a.walletBalance)!==0||Number(a.unrealizedProfit)!==0)line($('assets'),[a.asset,a.walletBalance,a.availableBalance,a.marginBalance]);
  $('log').replaceChildren();for(const v of e.events){const d=document.createElement('div');d.textContent=new Date(v.at).toLocaleTimeString()+' · '+v.text;$('log').append(d);}
}
async function run(fn,kind='action'){
 const target=engine;if(!target)return;
 try{await target.control(async()=>{if(engine===target)await fn();},kind);}
 catch(error){if(target.remote){target.block='Action not confirmed: '+error.message;status(target.block);return;}target.block=error.message;target.pause(error.message);}
 finally{render();}
}
async function acquireLock(){
  if(!navigator.locks)throw new Error('This browser cannot prevent duplicate trading tabs. Use current Chrome or Edge.');
  await new Promise((resolve,reject)=>{navigator.locks.request('btc-binance-demo-order-writer',{ifAvailable:true},lock=>{if(!lock){reject(new Error('Another tab is connected to Demo. Disconnect that tab first.'));return;}return new Promise(done=>{releaseLock=done;resolve();});}).catch(reject);});
}
$('connectform').onsubmit=async event=>{
  event.preventDefault();if(connectionBusy||engine?.connected||!$('demoOnly').checked)return;
  const key=$('key').value.trim(),secret=$('secret').value.trim();if(!key||!secret)return;
  const relayToken=$('localMode').checked?$('relayToken').value.trim():'';
  if($('localMode').checked&&relayToken.length<32){status('Paste the local connection token first.');return;}
  connectionBusy=true;render();
  if($('remember').checked){
    try{await saveCredentials({key,secret,relayToken,localMode:$('localMode').checked},$('vaultPassword').value);}
    catch(error){connectionBusy=false;render();status(error.message);return;}
  }
  $('vaultPassword').value='';
  $('relayToken').value='';
  $('key').value='';$('secret').value='';connectionBusy=true;render();status('Connecting to Binance Demo…');
  try{
    if(relayToken)await ensureNoBackground(relayToken);
    await acquireLock();
    const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
    const journalKey='btc_demo_orders_v1_'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    // Only a one-way fingerprint and non-secret order journal are persisted.
    const saved=localStorage.getItem(journalKey);const state=saved?JSON.parse(saved):null;
    const persist=value=>{try{localStorage.setItem(journalKey,JSON.stringify(value));}catch{throw new Error('Cannot save order journal. Entries stopped to prevent duplicates.');}};
    const api=new DemoAPI(key,signingKey);api.relayToken=relayToken;
    engine=new DemoEngine(api,state,persist,queueRender);engine.busy=true;
    await engine.initialize();engine.save();$('credentials').open=false;
    if(engine.tradingReady){
      try{await engine.start();}catch(error){engine.block=error.message;engine.pause(error.message);}
    }
  }catch(e){if(engine?.api?.key){engine.pause();engine.connected=false;status(e.message+' Credentials remain in memory: use Retry connection, or Disconnect to clear them.');}else{releaseLock?.();releaseLock=null;status(e.message);}}
  finally{connectionBusy=false;if(engine)engine.busy=false;render();if(engine?.auto)engine.tick();}
};
$('startTrial').onclick=async()=>{await run(()=>engine.startTrial(),'start');if(engine?.auto)engine.tick();};
$('endTrial').onclick=()=>run(()=>engine.endTrial());
$('start').onclick=async()=>{await run(()=>engine.start(),'start');if(engine?.auto)engine.tick();};
$('retry').onclick=async()=>{
  if(!engine?.api?.key||engine.busy)return;engine.busy=true;render();status('Retrying saved demo credentials…');
  try{await engine.initialize();engine.save();if(engine.connected)$('credentials').open=false;}
  catch(e){engine.block=e.message;engine.pause();status(e.message+' Use Retry connection or Disconnect.');}
  finally{engine.busy=false;render();}
};
$('stop').onclick=()=>{engine?.pause('Stopped by user. Existing protective exits remain.');render();};
$('again').onclick=()=>run(()=>engine.again());
$('refresh').onclick=()=>run(async()=>{if(!engine.tradingReady){await engine.refreshBalance();return;}await engine.refresh();await engine.reconcile();await engine.updateIncome();});
$('disconnect').onclick=()=>{
  if(engine?.remote){disconnectBackground();return;}
  if(engine?.busy)return;engine?.pause();engine?.api.clear();engine=null;releaseLock?.();releaseLock=null;$('credentials').open=true;$('demoOnly').checked=false;
  for(const id of ['positions','openOrders','trades','assets','setups','log'])$(id).replaceChildren();for(const id of ['combined','available','session','wallet','unrealized','pnlEquation','incomeAudit','incomeDiagnosis','sessionNote','unrealizedNote'])$(id).textContent='—';status('Disconnected. Accepted exchange exits remain on Binance Demo.');render();
};
setInterval(()=>{if(engine?.connected&&!engine.remote)engine.tick();},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&engine?.connected)engine.tick();});
window.addEventListener('beforeunload',event=>{if(engine?.busy&&!engine.remote){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{if(!engine?.remote){engine?.pause();engine?.api.clear();releaseLock?.();}});
render();

const paperLink=document.querySelector('a[href="./"]')||document.querySelector('a[href="index.html"]');
if(paperLink&&window.parent!==window){paperLink.textContent='Paper simulator';paperLink.onclick=event=>{event.preventDefault();parent.postMessage('show-paper',location.origin);};}

window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==parent||event.data!=='demo-refresh-assets')return;
 if(!engine?.connected){$('credentials').open=true;status('Connect Demo first to refresh Binance assets.');return;}
 $('refresh').click();
});

$('unlockSaved').onclick=async()=>{
 if(connectionBusy||engine?.api?.key)return;
 $('unlockSaved').disabled=true;
 try{
  const saved=await readCredentials($('vaultPassword').value);
  $('key').value=saved.key;$('secret').value=saved.secret;$('relayToken').value=saved.relayToken;
  $('localMode').checked=!!saved.localMode;$('remember').checked=false;$('vaultPassword').value='';
  status('Credentials unlocked. Tick the Demo permission checkbox, then Connect & Start Demo.');
 }catch(error){status(error.message);}
 finally{$('unlockSaved').disabled=false;}
};
$('forgetSaved').onclick=()=>{
 localStorage.removeItem(VAULT_ID);$('key').value='';$('secret').value='';$('relayToken').value='';$('vaultPassword').value='';
 status('Saved credentials deleted from this browser. An existing connection stays active until Disconnect.');
};

$('resetDemo').onclick=()=>run(()=>engine.resetFromBinance());

$('positionsTab').onclick=()=>{ $('positions').hidden=false;$('orderPanel').hidden=true;$('positionsTab').classList.add('selected');$('ordersTab').classList.remove('selected');};
$('ordersTab').onclick=()=>{ $('positions').hidden=true;$('orderPanel').hidden=false;$('ordersTab').classList.add('selected');$('positionsTab').classList.remove('selected');};

$('copyTradeReport').onclick=async()=>{
  if(!engine?.connected){status('Connect and sync before copying the trade report.');return;}
  const target=engine;let snapshot;
  $('tradeReportText').hidden=true;$('tradeReportText').value='';
  status('Refreshing Binance income and positions for the report…');
  try{
    const ran=await target.control(async()=>{if(engine!==target||!target.connected)throw Error('Connection changed; reconnect first.');snapshot=await target.freshTradeReport();});
    if(!ran){status('Another action is pending. Copy the report when it finishes.');return;}
  }catch(error){status('Report not copied: '+error.message);return;}
  const report=JSON.stringify(snapshot,null,2);
  try{await navigator.clipboard.writeText(report);status('Trade report copied. Includes results and entry evidence; no API credentials.');}
  catch{$('tradeReportText').hidden=false;$('tradeReportText').value=report;$('tradeReportText').focus();$('tradeReportText').select();status('Select and copy the displayed trade report.');}
};


// Snapshot-only diagnostics remain available when no entry exists or account reads fail.
$('copyScanDiagnostics').onclick=async()=>{
  const snapshot=engine?engine.scanDiagnostics():{reportType:'scan-diagnostics',appVersion:APP_VERSION,generatedAt:new Date().toISOString(),status:'No engine connected in this page.',connected:false,auto:false,recentChecks:[],localSnapshotOnly:true};
  snapshot.pageVersion=APP_VERSION;
  const text=JSON.stringify(snapshot,null,2);$('scanDiagnosticsText').hidden=true;
  try{await navigator.clipboard.writeText(text);$('entryStatus').textContent='Scan diagnostics copied — no trades or account refresh required.';}
  catch{$('scanDiagnosticsText').value=text;$('scanDiagnosticsText').hidden=false;$('scanDiagnosticsText').focus();$('scanDiagnosticsText').select();$('entryStatus').textContent='Select and copy the scan diagnostics shown below. No trades are required.';}
};
