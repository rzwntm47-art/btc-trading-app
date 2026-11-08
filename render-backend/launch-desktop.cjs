'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const OLD_CONNECTOR='The older connector cannot restart itself. Click Stop Auto, wait for pending actions, then close its old command window. Run START-LAPTOP.cmd again. Keep your saved data.';

function preflight({nodeVersion=process.versions.node,dir=__dirname}={}){
  if(Number(nodeVersion.split('.')[0])<22)throw Error('Node.js 22 or newer is required. Install the current Node.js LTS from https://nodejs.org and reopen START-LAPTOP.cmd.');
  for(const file of ['desktop.cjs','server.cjs','vendor/qrcode.cjs','../demo-execution/engine.js','../demo-execution/demo-connect.html']){
    if(!fs.existsSync(path.join(dir,file)))throw Error('Laptop files are incomplete. Extract the whole ZIP, keeping demo-execution and render-backend together, then run START-LAPTOP.cmd from the extracted folder. Missing: '+file);
  }
}
async function probe({base,token,fetcher=fetch}){
  let response;
  try{response=await fetcher(base+'/host/status',{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)});}
  catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw Error('Cannot verify port 10000. Check the existing connector window before retrying. No process was stopped.');}
  if(response.status===401)throw Error('A connector is already open with a different local token. Use that window, or Stop Auto and close it before retrying. No process was stopped.');
  if(response.status===404)throw Error(OLD_CONNECTOR);
  if(!response.ok)throw Error('Port 10000 is occupied by an unrecognized service. No process was stopped.');
  let state;try{state=await response.json();}catch{throw Error('Port 10000 is occupied by an unrecognized service. No process was stopped.');}
  if(state.service!=='btc-demo-laptop'||state.restartSupported!==true){
    if(state.version===2&&typeof state.generation==='string')throw Error(OLD_CONNECTOR);
    throw Error('Port 10000 is occupied by an unrecognized service. No process was stopped.');
  }
  return state;
}
async function prepareRestart({base='http://127.0.0.1:10000',token,fetcher=fetch,wait=delay,deadlineMs=10000,log=console.log}={}){
  const state=await probe({base,token,fetcher});if(!state)return;
  if(state.restarting)throw Error('A restart is already in progress. Wait for the new connector window; do not open another copy.');
  log('Restarting the existing laptop connector. Waiting for pending actions to finish…');
  let response;
  try{response=await fetcher(base+'/host/restart',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({generation:state.generation}),redirect:'error',signal:AbortSignal.timeout(35000)});}
  catch{throw Error('Restart was not confirmed. Check the existing connector window and sync before retrying. No replacement was started.');}
  let result;try{result=await response.json();}catch{throw Error('Unexpected restart response. No replacement was started.');}
  if(response.status!==202||result.ok!==true||result.generation!==state.generation)throw Error(result.error||'Restart was not accepted. No replacement was started.');
  const until=Date.now()+deadlineMs;
  do{
    const current=await probe({base,token,fetcher});if(!current)return;
    if(current.generation!==state.generation)throw Error('Another connector has already started. Use its window; no duplicate was started.');
    await wait(100);
  }while(Date.now()<until);
  throw Error('The old connector has not released port 10000. No duplicate was started. Check its window before retrying.');
}
async function main({port=10000,dataDir,log=console.log}={}){
  try{
    preflight();
    // Load all engine dependencies before asking the existing process to stop.
    const {createDesktop,loadLocalToken}=require('./desktop.cjs');
    const {APP_VERSION}=require('../demo-execution/engine.js');
    const token=loadLocalToken(dataDir);await prepareRestart({base:'http://127.0.0.1:'+port,token,log});
    const {server}=createDesktop({token,dataDir});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    server.once('close',()=>log('This connector has stopped. If restarting, use the newly opened connector window.'));
    log('Laptop connector ready · trading engine V'+APP_VERSION+'. Keep this window open and laptop awake.');
    log('Local connection token (paste only into your laptop dashboard):\n'+token);
    log('Open https://rzwntm47-art.github.io/btc-trading-app/demo-connect.html?local=1');
    log('Choose Mobile — same account → Connect laptop / reconnect controls. Unlock saved keys if asked, then Start / Resume Demo.');
    log('History, the $20 session target, and remembered phone access are preserved. Restart does not start new trades.');
    return server;
  }catch(error){console.error(error.code==='EADDRINUSE'?'Another connector took port 10000. Use its window; no duplicate was started.':error.message);process.exitCode=1;}
}
if(require.main===module)main();
module.exports={main,preflight,probe,prepareRestart};
