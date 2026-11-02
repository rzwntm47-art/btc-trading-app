'use strict';
// Remote views receive snapshots and explicit commands only. They never execute DemoAPI calls.
const onPhoneController=location.pathname==='/mobile';
let remoteTransport=null,remotePollBusy=false,pairExpiryTimer;
function pairMessage(text){$('pairStatus').textContent=text;}
async function remoteRequest(transport,path,data){
  const headers={},options={method:data===undefined?'GET':'POST',headers,cache:'no-store',credentials:transport.mobile?'same-origin':'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)};
  if(transport.token)headers.Authorization='Bearer '+transport.token;
  if(data!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify({...data,...(transport.mobile?{csrf:transport.csrf}:{})});}
  let response;try{response=await fetch(transport.base+transport.prefix+path,options);}catch{throw Error(transport.mobile?'Cannot reach your laptop. Check that it is awake, the connector is open, and Tailscale is connected on both devices.':'Cannot reach the laptop connector. Run START-LAPTOP.cmd, allow local-network access if your browser asks, then try again.');}
  let result;try{result=await response.json();}catch{throw Error('Update the laptop connector using the download in Pair Mobile.');}
  if(!response.ok)throw Error(response.status===404?'This is the old connector. Download the update and run START-LAPTOP.cmd.':result.error||'Request failed ('+response.status+').');
  if(result.csrf)transport.csrf=result.csrf;
  return result;
}
class RemoteDemo extends DemoEngine{
  constructor(transport){super({key:'remote-controller',offset:0,clear(){}},null,()=>{});this.remote=true;this.transport=transport;}
  apply(snapshot){
    if(snapshot.engine)Object.assign(this,snapshot.engine);else{this.connected=false;this.auto=false;this.busy=false;this.controlPending=false;}
    this.appVersion=snapshot.engine?.appVersion||null;this.entryPolicy=snapshot.engine?.entryPolicy||null;this.scanAudit=snapshot.engine?.scanAudit||null;this.lastScan=snapshot.engine?.lastScan||0;this.lastContact=Date.now();this.lastServerAt=snapshot.serverAt;this.api.offset=snapshot.serverAt-Date.now();this.transport.generation=snapshot.generation;
    render();$('credentials').hidden=true;$('backgroundNote').hidden=false;$('browserRequirement').hidden=true;
    if(onPhoneController){$('resetDemo').hidden=true;$('pairMobile').hidden=true;}
    if(!this.connected)status(snapshot.connecting?'Laptop is connecting to Binance Demo. Please wait…':snapshot.error||'Laptop bot is disconnected. Reconnect on the laptop.');
    else status('LAPTOP BACKGROUND BOT · '+$('status').textContent);
    $('backgroundNote').textContent='Laptop engine '+(this.appVersion?'V'+this.appVersion:'version unavailable — update the laptop connector for the latest fixes')+'. Trading runs on the laptop. You may close this dashboard. Keep the laptop awake and its connector window open. Last contact: '+new Date(this.lastContact).toLocaleTimeString()+'.';
    if(!onPhoneController){if(snapshot.remoteOrigin&&!$('mobileOrigin').value)$('mobileOrigin').value=snapshot.remoteOrigin;pairMessage(snapshot.connecting?'Connecting in the background…':this.connected?'Laptop connected · '+snapshot.pairedDevices+' paired phone(s). Generate a QR below.':snapshot.error||'Reconnect Binance on the laptop.');}
  }
  async command(action,extra={}){
    const id=crypto.randomUUID();
    let entry=await remoteRequest(this.transport,'/command',{id,action,...extra});
    const until=Date.now()+180000;
    while(entry.status==='pending'&&Date.now()<until){await new Promise(r=>setTimeout(r,750));entry=await remoteRequest(this.transport,'/command?id='+encodeURIComponent(id));}
    if(entry.status==='pending')throw Error('Action is still running on the laptop. Sync before trying another command.');
    if(entry.status==='error')throw Error(entry.error);
    await pollRemote();return entry.report;
  }
  async control(fn){if(this.localControl)return false;this.localControl=true;try{await fn();return true;}finally{this.localControl=false;}}
  start(){return this.command('start');}
  startTrial(){return this.command('startTrial');}
  endTrial(){return this.command('endTrial');}
  pause(){this.command('stop').catch(error=>status('Stop was not confirmed: '+error.message));}
  refresh(){return this.command('refresh');}
  refreshBalance(){return this.refresh();}
  initialize(){return this.refresh();}
  reconcile(){return Promise.resolve();}
  updateIncome(){return Promise.resolve();}
  close(symbol){return this.command('close',{symbol});}
  again(){return this.command('again');}
  resetFromBinance(){return this.command('reset');}
  freshTradeReport(){return this.command('report');}
  tick(){return pollRemote();}
}
async function pollRemote(){
  if(!remoteTransport||remotePollBusy)return;remotePollBusy=true;
  try{
    const snapshot=await remoteRequest(remoteTransport,'/status');
    if(!engine?.remote)engine=new RemoteDemo(remoteTransport);
    engine.apply(snapshot);
  }catch(error){
    if(engine?.remote){engine.connected=false;engine.auto=false;render();}
    status('LAPTOP CONNECTION LOST · '+error.message+' The laptop may still be trading; no stop is confirmed.');pairMessage(error.message);
  }finally{remotePollBusy=false;}
}
async function attachBackground(transport,snapshot){
  remoteTransport=transport;engine=new RemoteDemo(transport);engine.apply(snapshot);
  $('key').value='';$('secret').value='';$('relayToken').value='';$('pairToken').value='';$('pairPassword').value='';
  releaseLock?.();releaseLock=null;
}
async function disconnectBackground(){
  if(!engine?.remote)return;
  try{await engine.command('disconnect');remoteTransport=null;engine=null;$('credentials').hidden=false;$('credentials').open=true;$('backgroundNote').hidden=true;status('Laptop background bot disconnected. Accepted exchange protective exits remain.');render();}
  catch(error){status('Disconnect not confirmed: '+error.message);}
}
async function ensureNoBackground(token){
  const transport={base:'http://127.0.0.1:10000',prefix:'/host',token};
  const response=await fetch(transport.base+'/host/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000),cache:'no-store',credentials:'omit'});
  if(response.status===404)return; // Existing V1 relay remains supported for browser mode.
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Cannot check laptop background bot.');
  if(data.connecting||data.engine)throw Error('The laptop background bot already owns trading. Click Pair Mobile → Connect laptop / reconnect controls.');
}
$('pairMobile').onclick=()=>{$('pairPanel').hidden=!$('pairPanel').hidden;if(!$('pairPanel').hidden)$('pairPanel').scrollIntoView({behavior:'smooth',block:'start'});};
$('closePair').onclick=()=>{$('pairPanel').hidden=true;};
$('connectBackground').onclick=async()=>{
  if(connectionBusy)return;
  $('connectBackground').disabled=true;pairMessage('Checking laptop connector…');
  try{
    let saved=null;const password=$('pairPassword').value;
    if(password)saved=await readCredentials(password);
    const token=$('pairToken').value.trim()||remoteTransport?.token||engine?.api?.relayToken||$('relayToken').value.trim()||saved?.relayToken;
    if(!token||token.length<32)throw Error('Paste the local token printed by START-LAPTOP.cmd.');
    const transport={base:'http://127.0.0.1:10000',prefix:'/host',token};
    const initial=await remoteRequest(transport,'/status');
    if(initial.version!==2)throw Error('Update the laptop connector first.');
    if(initial.engine||initial.connecting){
      if(engine&&!engine.remote){engine.pause();const old=engine;const stopped=await old.control(async()=>{old.connected=false;old.api.clear();});if(!stopped)throw Error('Wait for the current dashboard action to finish.');}
      await attachBackground(transport,initial);return;
    }
    const key=saved?.key||$('key').value.trim(),secret=saved?.secret||$('secret').value.trim();
    if(!key||!secret)throw Error('Enter your saved-key password above, or enter your Demo API key and HMAC secret in Connect Binance Demo first.');
    if(!$('backgroundConsent').checked)throw Error('Tick the Binance Demo confirmation above before moving trading to the laptop.');
    let state;
    if(engine&&!engine.remote){
      if(engine.api.key!==key)throw Error('The unlocked key is different from the active account. Use the same account for transfer.');
      const old=engine;old.pause('Moving control to the laptop background bot.');
      const stopped=await old.control(async()=>{old.save();state=JSON.parse(JSON.stringify(old.state));old.connected=false;old.api.clear();});
      if(!stopped)throw Error('Wait for the current dashboard action to finish.');
    }else{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      const journalKey='btc_demo_orders_v1_'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
      const raw=localStorage.getItem(journalKey);state=raw?JSON.parse(raw):null;
    }
    releaseLock?.();releaseLock=null;engine=null;render();
    // Once submitted, never resume the browser bot automatically, even on a lost response.
    remoteTransport=transport;
    const snapshot=await remoteRequest(transport,'/connect',{requestId:crypto.randomUUID(),key,secret,state,demoOnly:true});
    await attachBackground(transport,snapshot);pairMessage('Connecting. Automatic entries stay stopped until you press Start / Resume Demo.');
  }catch(error){pairMessage(error.message);}
  finally{$('pairPassword').value='';$('connectBackground').disabled=false;}
};
$('makeQr').onclick=async()=>{
  $('makeQr').disabled=true;$('pairQr').hidden=true;clearTimeout(pairExpiryTimer);
  try{
    if(!remoteTransport||remoteTransport.mobile||!engine?.remote||!engine.connected)throw Error('Connect the laptop background bot first using the button above.');
    const result=await remoteRequest(remoteTransport,'/pair',{origin:$('mobileOrigin').value.trim()});
    $('pairQrImage').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(result.svg);
    $('pairLink').href=result.url;$('pairLink').textContent='Open mobile controller';$('pairQr').hidden=false;
    $('pairQrNote').textContent='Scan with your phone camera. Open the link in Safari or Chrome with Tailscale on. Expires in 2 minutes and works once. Add the controller to your home screen after pairing.';
    pairExpiryTimer=setTimeout(()=>{$('pairQr').hidden=true;$('pairQrImage').removeAttribute('src');$('pairLink').removeAttribute('href');pairMessage('QR expired. Generate a new one.');},Math.max(0,result.expires-Date.now()));
  }catch(error){pairMessage(error.message);}
  finally{$('makeQr').disabled=false;}
};
$('revokePhones').onclick=async()=>{
  try{if(!remoteTransport||remoteTransport.mobile)throw Error('Connect the laptop controls first.');await remoteRequest(remoteTransport,'/revoke',{});$('pairQr').hidden=true;clearTimeout(pairExpiryTimer);await pollRemote();pairMessage('All phone access revoked. Laptop trading state is unchanged.');}
  catch(error){pairMessage(error.message);}
};
setInterval(()=>{if(remoteTransport)pollRemote();},3000);
if(onPhoneController){
  $('credentials').hidden=true;$('pairMobile').hidden=true;$('pairPanel').hidden=true;$('resetDemo').hidden=true;
  const paper=document.querySelector('a[href="./"]');if(paper)paper.hidden=true;
  $('backgroundNote').hidden=false;$('backgroundNote').textContent='Connecting to your laptop…';
  const code=new URLSearchParams(location.hash.slice(1)).get('pair');history.replaceState(null,'','/mobile');
  remoteTransport={base:'',prefix:'/mobile',mobile:true};
  (async()=>{try{if(code)await remoteRequest(remoteTransport,'/pair',{code});await pollRemote();}catch(error){status(error.message);}})();
}
