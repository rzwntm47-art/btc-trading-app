const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {DemoEngine}=require('./engine.js');
function fixture(){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:false,textContent:'',classList:{add(){},remove(){}},replaceChildren(){}});return nodes.get(id);};
 const intervals=[],events={};const paperLink={};const messages=[];const parent={postMessage:(...args)=>messages.push(args)};
 const context=vm.createContext({DemoEngine,console,parent,setTimeout,setInterval(fn){intervals.push(fn);},document:{getElementById:node,querySelector(){return paperLink;},addEventListener(type,fn){events[type]=fn;}},window:{addEventListener(){}},location:{origin:'http://test'},localStorage:{getItem(){return null;}}});
 vm.runInContext(fs.readFileSync(__dirname+'/ui.js','utf8'),context);
 vm.runInContext(`render=()=>{};engine=new DemoEngine({offset:0,key:'test'},null,()=>{});engine.connected=true;engine.tick=async()=>{};engine.state.startedAt=Date.now()-1000;engine.refresh=async()=>{engine.positionAt=Date.now();};engine.reconcile=async()=>{};engine.updateIncome=async()=>{engine.lastIncome=Date.now();engine.incomeWindowStart=engine.state.startedAt;};`,context);
 return {node,context,intervals,events,paperLink,messages,e:vm.runInContext('engine',context)};
}
test('real Start/Stop handlers: Stop wins while setup is pending',async()=>{
 const {node,e}=fixture();let finish;e.prepareTrading=()=>new Promise(r=>finish=r);
 const start=node('start').onclick();await new Promise(r=>setImmediate(r));assert.equal(e.busy,true);
 node('stop').onclick();finish();await start;assert.equal(e.auto,false);assert.equal(e.busy,false);
});
test('real Sync handler queues behind polling and refreshes exactly once',async()=>{
 const {node,e}=fixture();e.tradingReady=true;e.busy=true;let reads=0;e.refresh=async()=>reads++;
 const sync=node('refresh').onclick();assert.equal(e.controlPending,true);assert.equal(reads,0);
 e.busy=false;await sync;assert.equal(reads,1);assert.equal(e.controlPending,false);
});
test('real Reset and tab handlers dispatch correctly',async()=>{
 const {node,e}=fixture();let resets=0;e.resetFromBinance=async()=>resets++;
 await node('resetDemo').onclick();assert.equal(resets,1);
 node('ordersTab').onclick();assert.equal(node('positions').hidden,true);assert.equal(node('orderPanel').hidden,false);
 node('positionsTab').onclick();assert.equal(node('positions').hidden,false);assert.equal(node('orderPanel').hidden,true);
});

test('background tab polling and paper navigation preserve Demo Auto; explicit Stop still stops',async()=>{
 const {node,context,intervals,events,paperLink,messages,e}=fixture();
 e.auto=true;let ticks=0;e.tick=async()=>ticks++;
 context.document.hidden=true;
 for(const tick of intervals)tick();
 assert.equal(ticks,1);assert.equal(e.auto,true);
 paperLink.onclick({preventDefault(){}});
 assert.equal(messages[0][0],'show-paper');assert.equal(e.auto,true);
 context.document.hidden=false;events.visibilitychange();
 assert.equal(ticks,2);assert.equal(e.auto,true);
 node('stop').onclick();assert.equal(e.auto,false);
});
test('shell navigation does not send a visibility pause to the mounted demo',()=>{
 const shell=fs.readFileSync(__dirname+'/../index.html','utf8');
 assert.ok(!shell.includes("postMessage('demo-pause'"));
 const ui=fs.readFileSync(__dirname+'/ui.js','utf8');
 assert.ok(!ui.includes('shouldScan=demoVisible'));
});

test('Copy trade report uses connected snapshots and excludes API credentials',async()=>{
 const {node,context,e}=fixture();let copied='';
 context.navigator={clipboard:{writeText:async text=>copied=text}};e.api.key='private-key';
 e.income=[{incomeType:'REALIZED_PNL',income:'-50'},{incomeType:'COMMISSION',income:'-5.38'}];
 await node('copyTradeReport').onclick();const report=JSON.parse(copied);
 assert.equal(report.totals.net,-55.38);assert.ok(!copied.includes('private-key'));
 assert.match(node('status').textContent,/copied/);
});
test('Copy trade report provides selectable text when clipboard access fails',async()=>{
 const {node,context}=fixture();context.navigator={clipboard:{writeText:async()=>{throw Error('Unavailable');}}};
 node('tradeReportText').focus=()=>{};node('tradeReportText').select=()=>{};
 await node('copyTradeReport').onclick();assert.equal(node('tradeReportText').hidden,false);assert.equal(JSON.parse(node('tradeReportText').value).appVersion,'1.47');
});
test('Copy report waits for engine work and refreshes positions and income before export',async()=>{
 const {node,context,e}=fixture();let copied;const order=[];
 context.navigator={clipboard:{writeText:async text=>{copied=JSON.parse(text);order.push('copy');}}};
 const refresh=e.refresh,update=e.updateIncome;
 e.refresh=async()=>{order.push('positions');await refresh();};
 e.updateIncome=async()=>{order.push('income');e.income=[{incomeType:'COMMISSION',income:'-5.38'}];await update();};
 e.busy=true;const pending=node('copyTradeReport').onclick();assert.equal(order.length,0);assert.equal(e.controlPending,true);
 e.busy=false;await pending;assert.deepEqual(order,['positions','income','copy']);assert.equal(copied.snapshotStatus.complete,true);assert.equal(copied.totals.net,-5.38);
});
test('failed income refresh does not copy false zeros or interrupt Auto',async()=>{
 const {node,context,e}=fixture();let copied=false;e.auto=true;
 context.navigator={clipboard:{writeText:async()=>copied=true}};
 e.updateIncome=async()=>{throw Error('Income endpoint unavailable');};
 await node('copyTradeReport').onclick();assert.equal(copied,false);assert.match(node('status').textContent,/Report not copied: Income endpoint unavailable/);
 assert.equal(e.auto,true);assert.equal(e.busy,false);assert.equal(e.controlPending,false);assert.equal(node('tradeReportText').hidden,true);
});

