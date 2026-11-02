const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {DemoEngine}=require('./engine.js');
function fixture(){
 class FakeNode{constructor(){this.disabled=false;this.hidden=false;this.textContent='';this.children=[];this.classList={add(){},remove(){}};}append(...items){this.children.push(...items);}replaceChildren(){this.children=[];}}
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,new FakeNode());return nodes.get(id);};
 const intervals=[],events={};const paperLink={};const messages=[];const parent={postMessage:(...args)=>messages.push(args)};
 const context=vm.createContext({Node:FakeNode,DemoEngine,APP_VERSION:'1.65',console,parent,setTimeout,setInterval(fn){intervals.push(fn);},document:{getElementById:node,createElement(){return new FakeNode();},querySelector(){return paperLink;},addEventListener(type,fn){events[type]=fn;}},window:{addEventListener(){}},location:{origin:'http://test'},localStorage:{getItem(){return null;}}});
 vm.runInContext(fs.readFileSync(__dirname+'/ui.js','utf8'),context);
 vm.runInContext(`const renderActual=render;render=()=>{};engine=new DemoEngine({offset:0,key:'test'},null,()=>{});engine.bandRules=false;engine.entryPolicy={margin:300,maxLeverage:10,lossLimit:5,profitExit:'net-trailing',sessionExit:'close-bot-positions'};engine.connected=true;engine.tick=async()=>{};engine.state.startedAt=Date.now()-1000;engine.refresh=async()=>{engine.positionAt=Date.now();};engine.reconcile=async()=>{};engine.updateIncome=async()=>{engine.lastIncome=Date.now();engine.incomeWindowStart=engine.state.startedAt;};`,context);
 return {node,context,intervals,events,paperLink,messages,e:vm.runInContext('engine',context)};
}
test('unsupported connector shows an actionable update banner and clears after recovery',()=>{
 const {node,context,e}=fixture();e.auto=true;e.accountingUpdateRequired=true;
 vm.runInContext('renderActual()',context);assert.equal(node('connectorUpdate').hidden,false);assert.match(node('status').textContent,/CONNECTOR UPDATE REQUIRED/);assert.match(node('entryStatus').textContent,/fee-history/);assert.equal(node('stop').disabled,false);
 e.accountingUpdateRequired=false;vm.runInContext('renderActual()',context);assert.equal(node('connectorUpdate').hidden,true);
});
test('scan rows expose every timeframe and per-candidate entry rejection',()=>{
 const {node,context,e}=fixture();e.scanned=[{symbol:'BTCUSDT',side:'BUY',reason:'Selected 15m',at:Date.now(),checks:[{minutes:1,side:'WAIT',reason:'No aligned momentum'},{minutes:15,side:'BUY',reason:'Qualified'},{minutes:240,side:'WAIT',reason:'Volume low'}],entryCandidates:[{minutes:1,reason:'1m rejected'},{minutes:15,reason:'Entry candidate selected'}]}];
 vm.runInContext('renderActual()',context);const collect=n=>n.textContent+' '+n.children.map(collect).join(' '),text=collect(node('setups'));
 assert.match(text,/3 timeframe checks/);assert.match(text,/240m.*Volume low/);assert.match(text,/Entry 15m.*Entry candidate selected/);
});
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
 await node('copyTradeReport').onclick();assert.equal(node('tradeReportText').hidden,false);assert.equal(JSON.parse(node('tradeReportText').value).appVersion,'1.65');
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


test('Copy scan diagnostics works with zero trades while busy and disconnected without account calls',async()=>{
 const {node,e,context}=fixture();let copied;e.connected=false;e.busy=true;
 e.refresh=async()=>{throw Error('No fresh account read permitted');};e.updateIncome=e.refresh;e.api.call=e.refresh;
 context.navigator={clipboard:{writeText:async text=>copied=JSON.parse(text)}};
 await node('copyScanDiagnostics').onclick();assert.equal(copied.reportType,'scan-diagnostics');assert.equal(copied.connected,false);assert.equal(copied.scanAudit.checked,0);assert.equal(e.state.records.length,0);assert.equal(e.busy,true);
});
test('Copy scan diagnostics works before creating a connection and has a selectable fallback',async()=>{
 const {node,context}=fixture();vm.runInContext('engine=null;',context);context.navigator={clipboard:{writeText:async()=>{throw Error('Denied');}}};
 node('scanDiagnosticsText').focus=()=>{};node('scanDiagnosticsText').select=()=>{};
 await node('copyScanDiagnostics').onclick();assert.equal(node('scanDiagnosticsText').hidden,false);assert.equal(JSON.parse(node('scanDiagnosticsText').value).appVersion,'1.65');assert.match(node('entryStatus').textContent,/No trades are required/);
});
test('position cards separate Binance gross PnL, closing net, and once-only reduction status',()=>{
 const {context,e,node}=fixture();e.tradingReady=true;e.accountAt=e.positionAt=Date.now();
 e.account={assets:[{asset:'USDT',availableBalance:'4700',walletBalance:'5000'}]};
 e.positions=[{symbol:'BTCUSDT',positionAmt:'2',entryPrice:'100',markPrice:'101',unRealizedProfit:'2',positionInitialMargin:'200'}];
 e.state.records=[{id:'bd1_test',symbol:'BTCUSDT',side:'BUY',entryStatus:'FILLED',exitPolicy:'net-trailing',profitFloor:4,trailPeak:5,netEstimate:-.5,exitsReady:true,lossReduction:{status:'DONE',executedQty:1},closingEstimate:{source:'best bid/ask',at:Date.now(),paidCommission:1,closingFee:.5,realized:-2,funding:0}}];
 vm.runInContext('renderActual()',context);
 const flatten=n=>[n.textContent,...(n.children||[]).flatMap(flatten)].join(' '),text=flatten(node('positions'));
 assert.match(text,/PNL \(USDT\)/);assert.match(text,/Estimated total trade net/);assert.match(text,/-0.50/);
 assert.match(text,/Reduction: DONE/);assert.match(text,/1 units closed/);
 assert.match(node('leverageWindow').textContent,/net profit floors/);assert.equal(node('pending').textContent,'');
 e.state.records[0].lossReduction.status='PENDING';vm.runInContext('renderActual()',context);assert.match(node('pending').textContent,/25% reduction pending/);
});

test('experiment controls dispatch once and show remaining time without restarting it',async()=>{
 const {node,e,context}=fixture();let starts=0,ends=0;e.startTrial=async()=>{starts++;};e.endTrial=()=>{ends++;};await node('startTrial').onclick();await node('endTrial').onclick();assert.equal(starts,1);assert.equal(ends,1);
 const at=Date.now();e.state.oneHourTrial={startedAt:at,until:at+3600000,id:'trial_ui'};e.account={assets:[]};e.auto=true;vm.runInContext('renderActual()',context);
 assert.equal(node('startTrial').disabled,true);assert.equal(node('endTrial').disabled,false);assert.match(node('trialStatus').textContent,/EXPERIMENT RUNNING/);assert.match(node('leverageWindow').textContent,/150×/);
 e.state.oneHourTrial.startedAt-=3600001;e.state.oneHourTrial.until-=3600001;vm.runInContext('renderActual()',context);assert.match(node('trialStatus').textContent,/Normal entries restored/);assert.match(node('leverageWindow').textContent,/up to 10×/);
});

test('retry countdown keeps Stop enabled and does not suggest Auto must be clicked again',()=>{
 const {e,node,context}=fixture();e.account={assets:[]};e.tradingReady=true;e.auto=true;e.retryAt=Date.now()+30000;e.block='Temporary read failure';
 vm.runInContext('renderActual()',context);assert.match(node('status').textContent,/AUTO WAITING · automatic retry/);assert.equal(node('stop').disabled,false);assert.equal(node('start').disabled,true);assert.match(node('entryStatus').textContent,/Retrying in/);
});
test('Stepped UI exposes current risk and profit floors and hides the old experiment',()=>{
 const {node,context,e}=fixture();const current=new DemoEngine({offset:0});e.bandRules=true;e.entryPolicy=current.entryPolicy;
 e.positions=[{symbol:'BTCUSDT',positionAmt:'1',entryPrice:'100',markPrice:'101',unRealizedProfit:'1'}];e.state.records=[{id:'bd1_band',symbol:'BTCUSDT',side:'BUY',rulesVersion:12,exitPolicy:'stepped-net-trailing',lossLimit:6,maxLossLimit:12,netEstimate:9,trailPeak:9,profitFloor:8,exits:[]}];
 vm.runInContext('renderActual()',context);assert.equal(node('trialPanel').hidden,true);assert.match(node('leverageWindow').textContent,/1m \/ 2m.*10m.*60m Bollinger/);assert.match(node('leverageWindow').textContent,/normal loss \$6/);assert.match(node('budgetValue').textContent,/no smaller orders/);
 const collect=n=>n.textContent+' '+n.children.map(collect).join(' '),text=collect(node('positions'));assert.match(text,/Profit pullback floor/);assert.match(text,/\$8.00/);assert.match(text,/\$6 \/ \$12 targets/);assert.match(text,/No timer or partial reduction/);assert.ok(!text.includes('trim 25%'));
});
test('an older V1.59 Bollinger laptop reports its actual $2 risk-sized policy rather than the new settings',()=>{
 const {node,context,e}=fixture();e.bandRules=true;e.remote=true;e.appVersion='1.59';e.entryPolicy={margin:300,maxLeverage:150,strategy:'bollinger-wr-5m',lossLimit:2,profitExit:'bollinger-targets'};
 vm.runInContext('renderActual()',context);assert.equal(node('connectorUpdate').hidden,false);assert.match(node('leverageWindow').textContent,/up to \$300 risk-sized margin/);assert.match(node('leverageWindow').textContent,/\$2 total after-fee loss/);assert.ok(!node('leverageWindow').textContent.includes('maximum Binance-accepted'));
});

test('Sync read failure keeps running Auto in retry mode and Stop cancels that intent',async()=>{
 const {node,e,context}=fixture();e.auto=true;e.tradingReady=true;const error=Object.assign(new Error('temporary read'),{code:503,requestMethod:'GET',requestPath:'/fapi/v3/account',uncertain:false});
 e.refresh=async()=>{throw error;};await node('refresh').onclick();assert.equal(e.auto,true);assert.ok(e.retryAt>Date.now());vm.runInContext('renderActual()',context);assert.match(node('status').textContent,/AUTO WAITING/);
 node('stop').onclick();assert.equal(e.auto,false);assert.equal(e.retryAt,0);
});

test('entry holds display enabled Auto separately from stopped entries and preserve Stop control',()=>{
 const {e,node,context}=fixture();e.bandRules=true;e.account={assets:[]};e.tradingReady=true;e.auto=true;e.holdEntries('Order status still settling');
 vm.runInContext('renderActual()',context);assert.match(node('status').textContent,/AUTO ENABLED · NEW ENTRIES WAITING/);assert.match(node('entryStatus').textContent,/Position management continues/);assert.equal(node('stop').disabled,false);assert.equal(node('start').disabled,true);
 node('stop').onclick();vm.runInContext('renderActual()',context);assert.equal(e.auto,false);assert.match(node('status').textContent,/NEW ENTRIES STOPPED · POSITION CHECKS CONTINUE/);
});
