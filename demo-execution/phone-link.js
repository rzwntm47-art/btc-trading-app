'use strict';
// Explicit opt-in only: signaling starts when Create phone link is clicked or
// a phone link is opened. The signaling service sees no credentials or reports.
let directPhoneHost=null,directPhoneClient=null,phoneLinkBusy=false;
const PHONE_SESSION_KEY='btc_demo_direct_phone_v1';
const PHONE_NETWORK_ERROR='Could not connect the two browsers. Keep the laptop trading tab open. Try the phone on the same Wi-Fi, then tap Reconnect phone.';
function directMessage(text){$('directPhoneStatus').textContent=text;}
function makePhonePeer(){
 if(typeof Peer==='undefined'||typeof RTCPeerConnection==='undefined')throw Error('Phone links require a current Chrome, Edge or Safari browser.');
 // Free PeerJS TURN service was retired. Do not rely on the obsolete defaults.
 return new Peer('btc-'+crypto.randomUUID(),{host:'0.peerjs.com',port:443,secure:true,debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'}]}});
}
function waitPhonePeer(peer){if(peer.open)return Promise.resolve(peer.id);return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{peer.destroy();reject(Error('Phone-link service is unavailable. Retry Create phone link.'));},18000);
 peer.on('open',id=>{clearTimeout(timer);resolve(id);});peer.on('error',()=>{clearTimeout(timer);reject(Error('Phone-link service is unavailable. Retry Create phone link.'));});
});}
function revokeDirectPhone(message='Phone link revoked. Laptop trading is unchanged.'){
 const host=directPhoneHost;directPhoneHost=null;
 if(host){host.core.revoke();clearTimeout(host.timer);for(const c of host.connections)c.close();host.peer.destroy();}
 $('directPhoneLink').value='';$('directPhoneResult').hidden=true;$('revokeDirectPhone').hidden=true;directMessage(message);
}
function attachPhoneChannel(host,connection){
 if(directPhoneHost!==host||host.connections.size>=3){connection.close();return;}
 host.connections.add(connection);let verified=false,working=false,requests=0,windowAt=Date.now();
 const timer=setTimeout(()=>{if(!verified)connection.close();},10000);
 connection.on('close',()=>{clearTimeout(timer);host.connections.delete(connection);});
 connection.on('error',()=>connection.close());
 connection.on('data',async packet=>{
  if(working)return;working=true;
  try{
   if(directPhoneHost!==host||Date.now()>host.expires||!host.core.valid())throw Error('Link ended');
   if(Date.now()-windowAt>60000){windowAt=Date.now();requests=0;}if(++requests>120)throw Error('Too many requests');
   const request=await host.codec.open(packet);
   if(!request||typeof request.id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(request.id)||request.session!==host.id||!Number.isFinite(request.expires)||request.expires<Date.now()||request.expires>Date.now()+30000)throw Error('Invalid request');
   verified=true;clearTimeout(timer);directMessage('Phone connected to this dashboard. Keep this laptop tab open and laptop awake.');
   let result,error;try{result=host.core.handle(request.path,request.data);}catch(e){error=e.message;}
   const response=await host.codec.seal({id:request.id,session:host.id,result,error});
   if(directPhoneHost===host&&connection.open)connection.send(response);
  }catch{connection.close();}
  finally{working=false;}
 });
}
async function createDirectPhoneLink(){
 if(phoneLinkBusy||onPhoneController)return;
 $('directPhonePanel').hidden=false;$('directPhonePanel').scrollIntoView({behavior:'smooth',block:'start'});
 if(connectionBusy||!engine?.connected){directMessage('Connect Binance Demo above first. This button will then use that same connection.');return;}
 phoneLinkBusy=true;for(const id of ['createPhoneLink','createPhoneLinkToolbar'])$(id).disabled=true;
 const owner=engine;let peer;
 try{
  revokeDirectPhone('Creating phone link…');
  peer=makePhonePeer();const id=await waitPhonePeer(peer);
  if(engine!==owner||!owner.connected)throw Error('Laptop account changed. Connect, then create a new link.');
  const secret=PhoneLinkCore.random(),codec=await PhoneLinkCore.codec(secret,'laptop');
  const host={id,peer,codec,expires:Date.now()+8*3600000,connections:new Set(),core:PhoneLinkCore.host({getEngine:()=>engine,engine:owner,onChange:queueRender})};
  directPhoneHost=host;
  peer.on('connection',connection=>attachPhoneChannel(host,connection));
  peer.on('disconnected',()=>{if(directPhoneHost===host&&!peer.destroyed)try{peer.reconnect();}catch{directMessage('Phone-link service disconnected. Create a new link if the phone cannot reconnect.');}});
  peer.on('error',()=>{if(directPhoneHost===host)directMessage('Phone connection interrupted. Keep this tab open and reconnect from the phone.');});
  host.timer=setTimeout(()=>{if(directPhoneHost===host)revokeDirectPhone('Phone link expired after 8 hours. Create a new link.');},8*3600000);
  const url=new URL('demo-connect.html',location.href);url.search='?phone=1';url.hash=new URLSearchParams({peer:id,access:secret}).toString();
  $('directPhoneLink').value=url.href;$('directPhoneResult').hidden=false;$('revokeDirectPhone').hidden=false;
  directMessage('Link ready. Copy it to your phone. Keep this laptop tab open and laptop awake. Valid for this connection, up to 8 hours.');
 }catch(error){peer?.destroy();directMessage(error.message);}
 finally{phoneLinkBusy=false;for(const id of ['createPhoneLink','createPhoneLinkToolbar'])$(id).disabled=false;}
}
function closePhoneClient(){
 const client=directPhoneClient;directPhoneClient=null;
 if(client){client.connection?.close();client.peer.destroy();for(const request of client.pending.values()){clearTimeout(request.timer);request.reject(Error(PHONE_NETWORK_ERROR));}client.pending.clear();}
}
async function connectDirectPhone(){
 if(phoneLinkBusy)return;phoneLinkBusy=true;$('reconnectPhone').disabled=true;
 closePhoneClient();
 try{
  const params=new URLSearchParams(location.hash.slice(1));let saved;
  if(params.has('peer')||params.has('access')){
   saved={id:params.get('peer'),secret:params.get('access')};
   history.replaceState(null,'',location.pathname+'?phone=1');
  }else try{saved=JSON.parse(sessionStorage.getItem(PHONE_SESSION_KEY)||'null');}catch{}
  if(!saved||!/^btc-[a-f0-9-]{36}$/.test(saved.id)||!/^[A-Za-z0-9_-]{43}$/.test(saved.secret))throw Error('Open the full phone link copied from the laptop.');
  // Session storage lets this phone tab reconnect after a refresh. No API keys.
  try{sessionStorage.setItem(PHONE_SESSION_KEY,JSON.stringify(saved));}catch{}
  directMessage('Connecting to your laptop dashboard…');status('Connecting to the laptop. No second trading bot is started.');
  const peer=makePhonePeer(),client={peer,pending:new Map(),codec:await PhoneLinkCore.codec(saved.secret,'phone'),id:saved.id};directPhoneClient=client;
  await waitPhonePeer(peer);if(directPhoneClient!==client)throw Error('Connection replaced');
  const connection=peer.connect(saved.id,{serialization:'binary',reliable:true});client.connection=connection;
  const lost=()=>{for(const p of client.pending.values()){clearTimeout(p.timer);p.reject(Error(PHONE_NETWORK_ERROR));}client.pending.clear();if(directPhoneClient===client){if(engine?.remote){engine.connected=false;engine.auto=false;render();}status('PHONE CONNECTION LOST · Laptop may still be trading; no stop is confirmed.');directMessage(PHONE_NETWORK_ERROR);}};
  connection.on('close',lost);connection.on('error',lost);peer.on('error',lost);
  connection.on('data',async packet=>{try{const response=await client.codec.open(packet);if(response.session!==saved.id)return;const pending=client.pending.get(response.id);if(!pending)return;client.pending.delete(response.id);clearTimeout(pending.timer);if(response.error)pending.reject(Error(response.error));else pending.resolve(response.result);}catch{connection.close();}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{connection.close();reject(Error(PHONE_NETWORK_ERROR));},20000);connection.on('open',()=>{clearTimeout(timer);resolve();});connection.on('error',()=>{clearTimeout(timer);reject(Error(PHONE_NETWORK_ERROR));});connection.on('close',()=>{clearTimeout(timer);reject(Error(PHONE_NETWORK_ERROR));});});
  const request=async(path,data)=>{
   if(directPhoneClient!==client||!connection.open)throw Error(PHONE_NETWORK_ERROR);
   const id=crypto.randomUUID(),expires=Date.now()+15000;
   if(data)data={...data,expires};
   const packet=await client.codec.seal({id,session:saved.id,path,data,expires});
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{client.pending.delete(id);reject(Error('Laptop reply was not confirmed. Sync before retrying an action.'));},16000);
    client.pending.set(id,{resolve,reject,timer});try{connection.send(packet);}catch{clearTimeout(timer);client.pending.delete(id);reject(Error(PHONE_NETWORK_ERROR));}
   });
  };
  remoteTransport={peerLink:true,mobile:true,request};engine=new RemoteDemo(remoteTransport);
  const first=await request('/status');engine.apply(first);directMessage('Connected to the same laptop account. Keep the laptop trading tab open.');
 }catch(error){closePhoneClient();directMessage(error.message);status(error.message);}
 finally{phoneLinkBusy=false;$('reconnectPhone').disabled=false;}
}
$('createPhoneLink').onclick=createDirectPhoneLink;
$('createPhoneLinkToolbar').onclick=createDirectPhoneLink;
$('revokeDirectPhone').onclick=()=>revokeDirectPhone();
$('copyDirectPhoneLink').onclick=async()=>{
 const value=$('directPhoneLink').value;if(!value)return;
 try{await navigator.clipboard.writeText(value);directMessage('Copied. Open this link on your own phone. Anyone holding the link can control this Demo session.');}
 catch{$('directPhoneLink').focus();$('directPhoneLink').select();directMessage('Select and copy the link shown below.');}
};
$('reconnectPhone').onclick=connectDirectPhone;
setInterval(()=>{if(directPhoneHost&&!directPhoneHost.core.valid())revokeDirectPhone('Laptop account disconnected or changed. Create a new link after connecting.');},1000);
window.addEventListener('pagehide',()=>{if(directPhoneHost)revokeDirectPhone();closePhoneClient();});
if(onPhoneController){for(const id of ['createPhoneLink','createPhoneLinkToolbar'])$(id).hidden=true;}
if(onLinkPhone){
 for(const id of ['credentials','pairMobile','pairPanel','resetDemo','disconnect'])$(id).hidden=true;
 const paper=document.querySelector('a[href="./"]');if(paper)paper.hidden=true;
 $('directPhonePanel').hidden=false;$('reconnectPhone').hidden=false;$('directPhoneHelp').textContent='This phone controls the connected laptop dashboard. Keep that laptop tab open and laptop awake.';
 connectDirectPhone();
}
