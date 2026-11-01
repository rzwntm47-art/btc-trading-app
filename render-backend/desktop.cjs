'use strict';
// Laptop-only service. Binance credentials live in memory, never in the QR or phone.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomBytes,createHash,timingSafeEqual,webcrypto}=require('node:crypto');
const {DemoAPI,DemoEngine}=require('../demo-execution/engine.js');
const {createServer}=require('./server.cjs');
const qrcode=require('./vendor/qrcode.cjs');
const DASHBOARD_ORIGIN='https://rzwntm47-art.github.io';
const DATA_DIR=path.join(os.homedir(),'.btc-demo-laptop');
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
function remoteOrigin(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||!/^[-a-z0-9]+\.[-a-z0-9]+\.ts\.net$/i.test(u.hostname)||u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Use the private HTTPS address shown by ENABLE-MOBILE.cmd, ending in .ts.net.');
  return u.origin;
}
function writeJson(file,data){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('JSON required');
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw Error('Request too large');}
  return JSON.parse(raw);
}
const SNAPSHOT_FIELDS=['appVersion','entryPolicy','scanAudit','lastScan','marketContext','scanStats','entryTiming','state','connected','tradingReady','auto','busy','controlPending','account','accountAt','positions','positionAt','orders','algos','ordersAt','scopedOrders','symbols','cursor','scanned','scanChecked','moversNote','income','lastIncome','incomeWindowStart','incomeWindowEnd','events','block','balance','newRules'];
function createDesktop({token,dataDir=DATA_DIR,fetcher=fetch,now=Date.now,Engine=DemoEngine,intervalMs=1000}={}){
  let engine=null,connecting=false,lastError='',pair=null,origin='',connectId='',generation=random();
  const sessions=new Map(),commands=new Map();
  try{origin=remoteOrigin(JSON.parse(fs.readFileSync(path.join(dataDir,'mobile-origin.json'),'utf8')).origin);}catch{}
  const snapshot=()=>({version:2,generation,connecting,error:lastError,remoteOrigin:origin,pairedDevices:sessions.size,serverAt:now(),engine:engine?Object.fromEntries(SNAPSHOT_FIELDS.map(k=>[k,engine[k]])):null});
  const locked=()=>connecting||!!engine?.api?.key;
  function persistFor(key){const file=path.join(dataDir,'journal-'+hash(key)+'.json');return {file,save:state=>writeJson(file,state)};}
  function startConnect(input){
    if(locked())throw Error('A background connection already exists. Reconnect to its controls instead.');
    if(!/^[A-Za-z0-9]{16,256}$/.test(input.key||'')||typeof input.secret!=='string'||input.secret.length<16||input.secret.length>512)throw Error('Enter your Binance Demo API key and HMAC secret on the laptop.');
    if(input.demoOnly!==true)throw Error('Confirm this is a Binance Demo key.');
    const journal=persistFor(input.key);
    const state=fs.existsSync(journal.file)?JSON.parse(fs.readFileSync(journal.file,'utf8')):input.state||null;
    // Validate before replacing a browser session. The server never auto-starts entries.
    new Engine({offset:0},state,()=>{});
    connecting=true;lastError='';connectId=input.requestId;
    (async()=>{
      try{
        const signingKey=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(input.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);input.secret='';
        let next=0;
        const pacedFetch=async(url,options)=>{if(options.headers?.['X-MBX-APIKEY']){const delay=Math.max(0,next-Date.now());if(delay)await new Promise(r=>setTimeout(r,delay));next=Date.now()+500;}return fetcher(url,options);};
        const api=new DemoAPI(input.key,signingKey,pacedFetch,webcrypto);
        engine=new Engine(api,state,journal.save);engine.busy=true;engine.save();
        await engine.initialize();engine.save();
      }catch(e){lastError=e.message;if(engine){engine.pause();engine.api.clear();engine=null;}}
      finally{connecting=false;if(engine)engine.busy=false;}
    })();
  }
  function command(input,owner){
    if(typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(input.id))throw Error('Command ID required');
    const dedupe=owner+':'+input.id;
    if(commands.has(dedupe))return commands.get(dedupe);
    if(!engine?.connected||connecting)throw Error('Laptop is not connected to Binance Demo.');
    if(!['start','stop','refresh','close','again','reset','report','disconnect'].includes(input.action))throw Error('Unsupported command');
    const e=engine,entry={id:input.id,status:'pending',action:input.action,at:now()};commands.set(dedupe,entry);
    if(commands.size>500)for(const [k,v] of commands)if(v.status!=='pending'){commands.delete(k);if(commands.size<=400)break;}
    if(input.action==='stop'){e.pause('Stopped from remote controls. Existing protective exits remain.');entry.status='done';return entry;}
    if(e.controlPending){entry.status='error';entry.error='Another action is pending. Wait for it to finish.';return entry;}
    (async()=>{try{
      const ran=await e.control(async()=>{
        if(input.action==='start')await e.start();
        if(input.action==='refresh'){if(e.tradingReady){await e.refresh();await e.reconcile();await e.updateIncome();}else await e.refreshBalance();}
        if(input.action==='close'){if(!/^[A-Z0-9]+USDT$/.test(input.symbol||'')||!e.owned(input.symbol))throw Error('Only this bot’s positions can be closed.');await e.close(input.symbol);}
        if(input.action==='again')await e.again();
        if(input.action==='reset')await e.resetFromBinance();
        if(input.action==='report')entry.report=await e.freshTradeReport();
        if(input.action==='disconnect'){e.pause();e.api.clear();engine=null;sessions.clear();pair=null;generation=random();}
      },input.action==='start'?'start':'action');
      if(!ran)throw Error('Action cancelled by Stop or another pending action.');entry.status='done';
    }catch(error){entry.status='error';entry.error=error.message;e.pause(error.message);}finally{entry.completedAt=now();}})();
    return entry;
  }
  const timer=setInterval(()=>{if(engine?.connected&&!connecting)engine.tick().catch(error=>{lastError=error.message;engine?.pause(error.message);});},intervalMs);timer.unref();
  let attempts=0,attemptWindow=now();
  async function extension(req,res,send){
    const pathname=req.url.split('?')[0];
    if(!pathname.startsWith('/host/')&&!pathname.startsWith('/mobile'))return false;
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      const isHost=pathname.startsWith('/host/');
      const allowedOrigin=isHost?DASHBOARD_ORIGIN:origin;
      if(req.headers.origin&&req.headers.origin!==allowedOrigin){send(403,{error:'Origin not allowed'});return true;}
      if(isHost){
        // Tailscale HTTPS requests must never reach laptop administration or key upload.
        if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||'')||req.headers['x-forwarded-for']||req.headers['x-forwarded-host']||req.headers['x-forwarded-proto']){send(403,{error:'Laptop-only endpoint'});return true;}
        if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',DASHBOARD_ORIGIN);res.setHeader('Vary','Origin');}
        if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'});res.end();return true;}
        if(!token||token.length<32||!equal(req.headers.authorization,'Bearer '+token)){send(401,{error:'Local connection token rejected. Use the token from START-LAPTOP.cmd.'});return true;}
      }else{
        if(!origin){send(503,{error:'Private mobile address is not configured on the laptop.'});return true;}
        // This listener binds only loopback. Tailscale Serve supplies the HTTPS origin.
        const host=req.headers['x-forwarded-host']||req.headers.host;
        if(host!==new URL(origin).host){send(403,{error:'Use the private HTTPS mobile address.'});return true;}
        if(req.method!=='GET'&&req.headers.origin!==origin){send(403,{error:'Same-origin request required'});return true;}
      }
      if(req.method==='GET'&&pathname==='/mobile'){
        const html=fs.readFileSync(path.join(__dirname,'../demo-execution/demo-connect.html'),'utf8');
        res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return true;
      }
      if(req.method==='POST'&&pathname==='/mobile/pair'){
        if(now()-attemptWindow>60000){attemptWindow=now();attempts=0;}if(++attempts>20){send(429,{error:'Too many pairing attempts. Wait one minute.'});return true;}
        const input=await body(req);
        if(!pair||pair.expires<=now()||typeof input.code!=='string'||!equal(hash(input.code),pair.hash)){send(401,{error:'Pairing code expired or already used. Generate another QR on the laptop.'});return true;}
        pair=null;const value=random(),csrf=random(),sid=hash(value);sessions.set(sid,{csrf,expires:now()+30*86400000});
        res.setHeader('Set-Cookie','__Host-btc-mobile='+value+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000');send(200,{csrf,...snapshot()});return true;
      }
      let sid='host',session;
      if(!isHost){
        const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-btc-mobile='))?.split('=')[1]||'';
        sid=hash(value);session=sessions.get(sid);
        if(!session||session.expires<=now()){sessions.delete(sid);send(401,{error:'Phone is not paired. Scan a new QR from the laptop.'});return true;}
      }
      if(req.method==='GET'&&(pathname==='/host/status'||pathname==='/mobile/status')){send(200,{...snapshot(),...(session?{csrf:session.csrf}:{})});return true;}
      if(req.method==='GET'&&(pathname==='/host/command'||pathname==='/mobile/command')){
        const id=new URL(req.url,'http://localhost').searchParams.get('id');const entry=commands.get(sid+':'+id);
        send(entry?200:404,entry||{error:'Command status unavailable. Sync before any retry.'});return true;
      }
      if(req.method!=='POST'){send(404,{error:'Not found'});return true;}
      const input=await body(req);
      if(session&&!equal(input.csrf,session.csrf)){send(403,{error:'Refresh this page before sending commands.'});return true;}
      if(pathname==='/host/connect'){
        if(typeof input.requestId!=='string'||input.requestId.length<16)throw Error('Connection request ID required');
        if(input.requestId!==connectId)startConnect(input);
        send(202,snapshot());return true;
      }
      if(pathname==='/host/pair'){
        if(!engine?.connected||connecting)throw Error('Connect the laptop background bot first.');
        const nextOrigin=remoteOrigin(input.origin);if(origin&&origin!==nextOrigin)sessions.clear();origin=nextOrigin;writeJson(path.join(dataDir,'mobile-origin.json'),{origin});
        if(sessions.size>=5)throw Error('Revoke paired phones before pairing more.');
        const code=random(),url=origin+'/mobile#pair='+code;pair={hash:hash(code),expires:now()+120000};
        const qr=qrcode(0,'M');qr.addData(url);qr.make();
        send(200,{url,expires:pair.expires,svg:qr.createSvgTag({cellSize:5,margin:20,scalable:true})});return true;
      }
      if(pathname==='/host/revoke'){pair=null;sessions.clear();send(200,{ok:true});return true;}
      if(pathname==='/host/command'||pathname==='/mobile/command'){
        if(session&&['disconnect','reset'].includes(input.action)){send(403,{error:'This action is available on the laptop only.'});return true;}
        send(202,command(input,sid));return true;
      }
      send(404,{error:'Not found'});return true;
    }catch(error){send(400,{error:error.message});return true;}
  }
  const server=createServer({token,fetcher,extension,relayLocked:locked});
  server.on('close',()=>{clearInterval(timer);engine?.pause();engine?.api.clear();});
  return {server,snapshot,locked};
}
if(require.main===module){
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});const file=path.join(DATA_DIR,'local-token');
  let token=process.env.RELAY_TOKEN;
  if(!token){try{token=fs.readFileSync(file,'utf8').trim();}catch{token=random();fs.writeFileSync(file,token,{mode:0o600});}}
  if(token.length<32)throw Error('RELAY_TOKEN must contain at least 32 characters.');
  const {server}=createDesktop({token});
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 10000 is already in use. Stop the old connector, then run START-LAPTOP.cmd again.':error.message);process.exitCode=1;});
  server.listen(10000,'127.0.0.1',()=>{
    console.log('Laptop connector V2 ready. Keep this window open and laptop awake.');
    console.log('Local connection token (paste only into your laptop dashboard):\n'+token);
    console.log('Open https://rzwntm47-art.github.io/btc-trading-app/ and click Pair Mobile.');
  });
}
module.exports={createDesktop,remoteOrigin,DATA_DIR};
