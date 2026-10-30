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
function demoVisible(){
  if(document.hidden)return false;
  try{const frame=window.frameElement;const dialog=frame?.closest('dialog');return !frame?.closest('[hidden]')&&(!dialog||dialog.open);}catch{return false;}
}
const money=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
function line(parent,values){const tr=document.createElement('tr');for(const v of values){const td=document.createElement('td');if(v instanceof Node)td.append(v);else td.textContent=String(v??'—');tr.append(td);}parent.append(tr);}
function status(message){$('status').textContent=message;}
function render(){
  const e=engine,connected=!!e?.connected;
  $('connect').disabled=connectionBusy||!!e?.api?.key;$('disconnect').disabled=!e?.api?.key||e.busy;
  $('retry').disabled=connectionBusy||!e?.api?.key||e.busy;
  $('start').disabled=!connected||e.busy||e.auto||e.state.goal;
  $('resetDemo').disabled=!connected||e.busy;
  $('stop').disabled=!connected;$('refresh').disabled=!connected||e.busy;
  $('again').disabled=!connected||e.busy||!e.state.startedAt||e.active().length>0||e.positions.some(p=>Number(p.positionAmt)!==0);
  if(!connected)return;
  status((e.auto?'AUTO RUNNING · scanning for qualifying signals':e.tradingReady?'DEMO CONNECTED · AUTO STOPPED':'BALANCE CONNECTED · TRADING NOT READY')+(e.busy?' · checking…':'')+(e.block?'\n'+e.block:'')+'\nLast account read: '+new Date(e.accountAt).toLocaleTimeString());
  $('leverageWindow').textContent=Date.now()+e.api.offset<e.overrideUntil?'50× override for new demo entries · expires '+new Date(e.overrideUntil).toLocaleString()+' · then adaptive 3× / 5× / 8×':'50× override expired · new entries use adaptive 3× / 5× / 8×';
  const capital=e.budgetStatus();$('budgetValue').textContent='Budget equity: $'+money(capital.equity)+' · Margin in use: $'+money(capital.reserved)+' · Room for new margin: $'+money(capital.free);
  $('combined').textContent=e.balance===null?'Unavailable':e.balance.toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:4});
  if(Number.isFinite(e.balance)&&e.balance>0){try{localStorage.setItem('btc_demo_balance_snapshot_v1',JSON.stringify({value:e.balance,at:e.accountAt,source:'Binance Demo combined margin value',usdtAvailable:Number(e.account?.assets.find(a=>a.asset==='USDT')?.availableBalance)}));}catch{/* Display remains usable if browser storage is unavailable. */}}
  $('balanceNote').textContent='Estimated conversion using Binance Demo asset indices; Binance website valuation may differ.';
  const usdt=e.account?.assets.find(a=>a.asset==='USDT');$('available').textContent=money(Number(usdt?.availableBalance));$('wallet').textContent='USDT wallet: '+money(Number(usdt?.walletBalance));
  $('session').textContent=e.state.startedAt?money(e.sessionNet()):'Not started';$('session').className=e.sessionNet()<0?'bad':'good';
  $('sessionNote').textContent=e.state.startedAt?'Since '+new Date(e.state.startedAt).toLocaleString()+(e.state.goal?' · goal reached':''):'Starts when you enable auto';
  $('scanTitle').textContent='Setups · '+e.symbols.length+' markets · '+(e.scanChecked||0)+' checks completed · repeats continuously · cycle '+(Math.floor(e.cursor/Math.max(1,e.symbols.length))+1);$('setups').replaceChildren();
  for(const s of e.scanned)line($('setups'),[s.symbol,s.side==='BUY'?'LONG · '+s.leverage+'× — '+s.reason:s.side==='SELL'?'SHORT · '+s.leverage+'× — '+s.reason:'WAIT — '+s.reason,new Date(s.at).toLocaleTimeString()]);
  if(!e.scanned.length)line($('setups'),[e.auto?'Scanning markets…':'Click Start / Resume Demo to scan','—','—']);
  $('positions').replaceChildren();
  const positions=e.positions.filter(p=>Number(p.positionAmt)!==0);
  $('positionsTab').textContent='Positions ('+positions.length+')';
  $('ordersTab').textContent='Open Orders ('+(e.orders.length+e.algos.length)+')';
  $('syncNote').textContent='Positions: '+(e.positionAt?new Date(e.positionAt).toLocaleTimeString():'awaiting sync')+' · Orders: '+(e.ordersAt?new Date(e.ordersAt).toLocaleTimeString():'awaiting sync')+' · Polls every 5s when idle; requests and cooldowns can delay updates.';
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
    if(r?.exitPolicy==='manual-profit-60s-loss'){const timer=document.createElement('p');timer.textContent=Number.isFinite(r.lossSince)?'Loss timer: '+Math.max(0,Math.floor((Date.now()+e.api.offset-r.lossSince)/1000))+' / 60 seconds since first observed net loss':'Loss timer: inactive · resets at net break-even or profit';card.append(timer);const review=document.createElement('p');review.textContent=(r.continuation||'Trend review pending for a profitable position')+(r.reviewAt?' · Checked '+new Date(r.reviewAt).toLocaleTimeString():'')+' · Profit floor: '+(Number.isFinite(r.profitFloor)?'$'+r.profitFloor.toFixed(2):'arms at $1 net profit')+' · Manual close available';card.append(review);}
    const b=document.createElement('button');b.textContent=r?(r.pendingClose?'Close awaiting confirmation':'Close position'):'Manage this position in Binance';b.disabled=e.busy||!r;b.onclick=()=>run(()=>e.close(p.symbol));card.append(b);$('positions').append(card);
  }
  if(!positions.length)$('positions').textContent='No open positions in the last Binance snapshot.';
  $('openOrders').replaceChildren();
  for(const o of [...e.orders,...e.algos])line($('openOrders'),[o.symbol+' / '+o.side,o.orderType||o.type||'Conditional',o.triggerPrice??o.stopPrice??o.price??'—',o.closePosition?'Entire position':o.origQty??o.quantity??'—',o.algoStatus||o.status||'Open']);
  if(!$('openOrders').children.length)line($('openOrders'),['No open orders','','','','']);
  $('pending').textContent=e.active().filter(r=>!r.protected||r.pendingClose).map(r=>r.symbol+' · '+(r.pendingClose?'close pending':r.entryStatus||'entry unresolved')).join(' | ');
  $('trades').replaceChildren();
  for(const r of [...e.state.records].reverse().slice(0,50)){
    const income=e.income.filter(x=>x.symbol===r.symbol&&Number(x.time)>=r.at&&(!r.closedAt||Number(x.time)<=r.closedAt));
    const pnl=income.reduce((s,x)=>s+Number(x.income),0);
    line($('trades'),[r.symbol,r.rejected?'Rejected':r.closedAt?'Closed':r.entryStatus||'Checking',r.rejected?'—':r.at<e.state.startedAt?'Earlier session':income.length?money(pnl):'Settling']);
  }
  $('assets').replaceChildren();for(const a of e.account?.assets||[])if(Number(a.walletBalance)!==0||Number(a.unrealizedProfit)!==0)line($('assets'),[a.asset,a.walletBalance,a.availableBalance,a.marginBalance]);
  $('log').replaceChildren();for(const v of e.events){const d=document.createElement('div');d.textContent=new Date(v.at).toLocaleTimeString()+' · '+v.text;$('log').append(d);}
}
async function run(fn){if(!engine||engine.busy)return;engine.busy=true;render();try{await fn();if(engine.tradingReady)await engine.refresh();else await engine.refreshBalance();}catch(e){engine.block=e.message;engine.pause(e.message);}finally{engine.busy=false;render();}}
async function acquireLock(){
  if(!navigator.locks)throw new Error('This browser cannot prevent duplicate trading tabs. Use current Chrome or Edge.');
  await new Promise((resolve,reject)=>{navigator.locks.request('btc-binance-demo-order-writer',{ifAvailable:true},lock=>{if(!lock){reject(new Error('Another tab is connected to Demo. Disconnect that tab first.'));return;}return new Promise(done=>{releaseLock=done;resolve();});}).catch(reject);});
}
$('connectform').onsubmit=async event=>{
  event.preventDefault();if(connectionBusy||engine?.connected||!$('demoOnly').checked)return;
  const key=$('key').value.trim(),secret=$('secret').value.trim();if(!key||!secret)return;
  const relayToken=$('localMode').checked?$('relayToken').value.trim():'';
  if($('localMode').checked&&relayToken.length<32){status('Paste the local connection token first.');return;}
  if($('remember').checked){
    try{await saveCredentials({key,secret,relayToken,localMode:$('localMode').checked},$('vaultPassword').value);}
    catch(error){status(error.message);return;}
  }
  $('vaultPassword').value='';
  $('relayToken').value='';
  $('key').value='';$('secret').value='';connectionBusy=true;render();status('Connecting to Binance Demo…');
  try{
    await acquireLock();
    const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
    const journalKey='btc_demo_orders_v1_'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    // Only a one-way fingerprint and non-secret order journal are persisted.
    const saved=localStorage.getItem(journalKey);const state=saved?JSON.parse(saved):null;
    const persist=value=>{try{localStorage.setItem(journalKey,JSON.stringify(value));}catch{throw new Error('Cannot save order journal. Entries stopped to prevent duplicates.');}};
    const api=new DemoAPI(key,signingKey);api.relayToken=relayToken;
    engine=new DemoEngine(api,state,persist,render);engine.busy=true;engine.shouldScan=demoVisible;
    await engine.initialize();engine.save();$('credentials').open=false;
    if(engine.tradingReady){
      try{await engine.start();}catch(error){engine.block=error.message;engine.pause(error.message);}
    }
  }catch(e){if(engine?.api?.key){engine.pause();engine.connected=false;status(e.message+' Credentials remain in memory: use Retry connection, or Disconnect to clear them.');}else{releaseLock?.();releaseLock=null;status(e.message);}}
  finally{connectionBusy=false;if(engine)engine.busy=false;render();if(engine?.auto)engine.tick();}
};
$('start').onclick=async()=>{await run(()=>engine.start());if(engine?.auto)engine.tick();};
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
  if(engine?.busy)return;engine?.pause();engine?.api.clear();engine=null;releaseLock?.();releaseLock=null;$('credentials').open=true;$('demoOnly').checked=false;
  for(const id of ['positions','openOrders','trades','assets','setups','log'])$(id).replaceChildren();for(const id of ['combined','available','session','wallet'])$(id).textContent='—';status('Disconnected. Accepted exchange exits remain on Binance Demo.');render();
};
setInterval(()=>{if(engine?.connected){if(!demoVisible()&&engine.auto)engine.pause('Demo view is hidden. New entries stopped; exchange exits remain.');engine.tick();}},5000);
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===parent&&event.data==='demo-pause'){engine?.pause('Demo view closed. New entries stopped; exchange exits remain.');render();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&engine?.connected)engine.tick();});
window.addEventListener('beforeunload',event=>{if(engine?.busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{engine?.pause();engine?.api.clear();releaseLock?.();});
render();

const paperLink=document.querySelector('a[href="./"]')||document.querySelector('a[href="index.html"]');
if(paperLink&&window.parent!==window){paperLink.textContent='Paper simulator';paperLink.onclick=event=>{event.preventDefault();engine?.pause('Switched to paper simulation.');parent.postMessage('show-paper',location.origin);};}

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
