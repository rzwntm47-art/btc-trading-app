'use strict';
// Phone control uses the already-connected laptop engine. No API credentials,
// local relay token or signing key is included in a snapshot, link or message.
const PhoneLinkCore=(()=>{
 const VERSION=1,MAX_PACKET=1500000;
 const fields=['resultResetSupported','appVersion','bandRules','entryPolicy','sessionCloseEstimate','scanAudit','lastScan','marketContext','scanStats','entryTiming','state','connected','tradingReady','auto','entryHold','lastRiskCheck','retryLimited','startPending','retryAt','retryAttempt','accountingUpdateRequired','busy','controlPending','account','accountAt','positions','positionAt','orders','algos','ordersAt','scopedOrders','symbols','cursor','scanned','scanChecked','moversNote','income','lastIncome','incomeWindowStart','incomeWindowEnd','events','block','balance','newRules'];
 const allowed=new Set(['start','stop','refresh','close','again','resetResult','report']);
 const b64=bytes=>{let s='';for(const n of new Uint8Array(bytes))s+=String.fromCharCode(n);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
 const un64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
 async function codec(secret,role){
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret)||!['laptop','phone'].includes(role))throw Error('Invalid phone link');
  const material=await crypto.subtle.importKey('raw',un64(secret),'HKDF',false,['deriveKey']);
  const key=direction=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode('btc-demo-phone-v1'),info:new TextEncoder().encode(direction)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const [sendKey,readKey]=await Promise.all([key(role),key(role==='laptop'?'phone':'laptop')]);
  return {
   async seal(value){const text=JSON.stringify(value);if(text.length>MAX_PACKET/2)throw Error('Phone message is too large');const iv=crypto.getRandomValues(new Uint8Array(12));return {v:VERSION,iv:b64(iv),body:b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},sendKey,new TextEncoder().encode(text)))};},
   async open(packet){if(!packet||packet.v!==VERSION||typeof packet.iv!=='string'||packet.iv.length!==16||typeof packet.body!=='string'||packet.body.length>MAX_PACKET)throw Error('Invalid phone message');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(packet.iv)},readKey,un64(packet.body))));}
  };
 }
 function snapshot(engine,generation,now=Date.now()){
  const view=Object.fromEntries(fields.map(k=>[k,engine[k]]));
  // Retain current positions/protection and enough history for the display.
  view.state={...engine.state,records:engine.state.records.filter((r,i,a)=>(!r.closedAt&&!r.rejected)||i>=a.length-150)};
  if(Array.isArray(view.events))view.events=view.events.slice(0,100);
  if(Array.isArray(view.scanned))view.scanned=view.scanned.slice(0,200);
  return JSON.parse(JSON.stringify({version:2,service:'btc-demo-browser-link',connectorVersion:engine.appVersion,generation,pairedDevices:1,serverAt:now,engine:view}));
 }
 function host({getEngine,engine:ownedEngine,now=Date.now,generation=crypto.randomUUID(),onChange=()=>{}}){
  const commands=new Map();let revoked=false;
  function current(){if(revoked||getEngine()!==ownedEngine||!ownedEngine.connected)throw Error('Laptop connection ended. Create a new link from the connected laptop dashboard.');return ownedEngine;}
  function command(input){
   const e=current();
   if(!input||typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(input.id)||!allowed.has(input.action))throw Error('Unsupported phone command');
   const fingerprint=JSON.stringify([input.action,input.symbol||null]);
   if(commands.has(input.id)){const saved=commands.get(input.id);if(saved.fingerprint!==fingerprint)throw Error('Command ID already used');return saved.entry;}
   if(commands.size>=1000)throw Error('Create a new phone link to continue controls.');
   if(!Number.isFinite(input.expires)||input.expires<now()||input.expires>now()+30000)throw Error('Phone action expired. Sync before trying again.');
   const entry={id:input.id,status:'pending',action:input.action,at:now()};commands.set(input.id,{fingerprint,entry});
   if(input.action==='stop'&&!e.remote){e.pause('Stopped from phone. Existing protective exits remain.');entry.status='done';onChange();return entry;}
   if(input.action==='stop'&&e.remote){
    // Stop must bypass a pending remote Start/Close, as it does on the laptop.
    e.command('stop').then(()=>{entry.status='done';},error=>{entry.status='error';entry.error=error.message;}).finally(()=>{entry.completedAt=now();onChange();});return entry;
   }
   if(e.controlPending){entry.status='error';entry.error='Another action is pending. Sync before trying again.';return entry;}
   (async()=>{
    try{
     const ran=await e.control(async()=>{
      current();if(input.expires<now())throw Error('Phone action expired while waiting. Sync before trying again.');
      if(e.remote){const result=await e.command(input.action,input.symbol?{symbol:input.symbol}:{});if(input.action==='resetResult')entry.reset=result;if(input.action==='report')entry.report=result;return;}
      if(input.action==='start')await e.start();
      if(input.action==='refresh'){if(e.tradingReady){await e.refresh();await e.reconcile();await e.updateIncome();}else await e.refreshBalance();}
      if(input.action==='close'){if(!/^[A-Z0-9]+USDT$/.test(input.symbol||'')||!e.owned(input.symbol))throw Error('Only this bot’s positions can be closed.');await e.close(input.symbol);}
      if(input.action==='again')await e.again();
      if(input.action==='resetResult')entry.reset=await e.resetResult();
      if(input.action==='report')entry.report=await e.freshTradeReport();
     },input.action==='start'?'start':'action');
     if(!ran)throw Error('Action cancelled by Stop or another pending action.');entry.status='done';
    }catch(error){entry.status='error';entry.error=error.message;}
    finally{entry.completedAt=now();onChange();}
   })();return entry;
  }
  return {generation,revoke(){revoked=true;},valid(){try{current();return true;}catch{return false;}},handle(path,data){
   const e=current();
   if(path==='/status'&&data===undefined)return snapshot(e,generation,now());
   if(path==='/command'&&data!==undefined)return command(data);
   if(/^\/command\?id=[a-zA-Z0-9_-]{16,80}$/.test(path)&&data===undefined){const entry=commands.get(path.split('=')[1])?.entry;if(!entry)throw Error('Command status unavailable. Sync before any retry.');return entry;}
   throw Error('Unsupported phone request');
  }};
 }
 return {codec,host,snapshot,random};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=PhoneLinkCore;
