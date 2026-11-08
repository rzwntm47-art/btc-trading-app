'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {DemoEngine,SESSION_TARGET,APP_VERSION}=require('../demo-execution/engine.js');
const {createDesktop}=require('./desktop.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('actual result button and laptop HTTP command confirm zero despite an old poll and retained order',async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'counter-flow-')),token='counter-flow-token-01234567890123456789';let live;
 class ExchangeFixture extends DemoEngine{
  constructor(...args){super(...args);live=this;}
  async initialize(){this.connected=true;this.tradingReady=true;this.balance=5000;this.account={assets:[{asset:'USDT',walletBalance:'5000',availableBalance:'5000',marginBalance:'5000',unrealizedProfit:'0'}]};this.positionAt=Date.now();this.accountAt=this.positionAt;}
  async refresh(){this.positionAt=Date.now();this.accountAt=this.positionAt;}
  async tick(){}
 }
 const app=createDesktop({token,dataDir,Engine:ExchangeFixture,fetcher:()=>{throw Error('No Binance network requests allowed');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const response=await fetch(base+'/host/connect',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:'counter-flow-connect-12345',key:'A'.repeat(64),secret:'s'.repeat(64),demoOnly:true})});assert.equal(response.status,202);
  for(let i=0;i<100&&app.snapshot().connecting;i++)await delay(2);assert.equal(live.connected,true);
  live.state.startedAt=Date.now()-3600000;live.state.dayOpenPnl=0;live.income=[{incomeType:'REALIZED_PNL',asset:'USDT',income:'-39.44',time:Date.now()-1000}];live.lastIncome=Date.now();live.incomeWindowStart=live.state.startedAt;live.incomeWindowEnd=Date.now();
  live.algos=[{symbol:'BTCUSDT',clientAlgoId:'bd1_saved_stop',algoStatus:'NEW'}];live.state.records=[{symbol:'BTCUSDT',id:'bd1_old',side:'BUY',entryStatus:'FILLED',closedAt:Date.now()-1000}];
  class Node{constructor(){this.children=[];this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.classList={add(){},remove(){}};}append(...items){this.children.push(...items);}replaceChildren(){this.children=[];this.textContent='';}scrollIntoView(){}removeAttribute(){}}
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  let hold=false,releaseOld,oldCaptured=false;
  const transportFetch=async(url,options)=>{const response=await fetch(url,options);if(hold&&url.endsWith('/status')){hold=false;const body=await response.text();oldCaptured=true;await new Promise(r=>releaseOld=r);return new Response(body,{status:response.status,headers:response.headers});}return response;};
  const context=vm.createContext({Node,DemoEngine,SESSION_TARGET,APP_VERSION,crypto:webcrypto,console,fetch:transportFetch,URL,URLSearchParams,AbortSignal,Response,setTimeout,clearTimeout,setInterval(){},document:{getElementById:node,createElement:()=>new Node(),querySelector:()=>null,addEventListener(){}},window:{addEventListener(){}},location:{origin:'https://rzwntm47-art.github.io',pathname:'/',hash:''},history:{replaceState(){}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},parent:{},navigator:{},TextEncoder,TextDecoder});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo-execution/ui.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo-execution/mobile.js'),'utf8'),context);
  context.transport={base,prefix:'/host',token};vm.runInContext('remoteTransport=transport;',context);await vm.runInContext('pollRemote()',context);assert.equal(node('session').textContent,'-39.44');
  hold=true;const oldPoll=vm.runInContext('pollRemote()',context);for(let i=0;i<100&&!oldCaptured;i++)await delay(2);assert.equal(oldCaptured,true);
  const click=node('resetResult').onclick();
  for(let i=0;i<100&&!live.state.resultResetSequence;i++)await delay(2);assert.equal(live.state.resultResetSequence,1);assert.match(node('resultResetMessage').textContent,/Reset requested/);
  releaseOld();await oldPoll;await click;
  assert.equal(node('session').textContent,'0.00');assert.match(node('resultResetMessage').textContent,/Reset confirmed/);assert.equal(node('sessionHeading').textContent,'Net trading result · $20 target');assert.equal(live.algos.length,1);assert.equal(live.state.records.length,1);assert.equal(live.auto,false);
  await vm.runInContext('pollRemote()',context);assert.equal(node('session').textContent,'0.00');assert.match(node('resultResetMessage').textContent,/Reset confirmed/);
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});}
});
