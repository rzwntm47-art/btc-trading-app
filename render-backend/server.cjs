'use strict';
const http=require('node:http');
const {timingSafeEqual}=require('node:crypto');
const BASE='https://demo-fapi.binance.com';
const ORIGIN='https://rzwntm47-art.github.io';
const routes={GET:new Set(['/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/positionSide/dual','/fapi/v1/multiAssetsMargin','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/commissionRate','/fapi/v1/income']),POST:new Set(['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/leverage','/fapi/v1/marginType']),DELETE:new Set(['/fapi/v1/algoOrder','/fapi/v1/order'])};
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)}
function createServer({fetcher=fetch,token=process.env.RELAY_TOKEN,now=Date.now}={}){
 let active=0,windowAt=now(),count=0,cooldown=0,probeAt=-Infinity,probe=null;
 return http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
  const origin=req.headers.origin;
  if(origin&&origin!==ORIGIN)return send(403,{error:'Origin not allowed'});
  if(origin){res.setHeader('Access-Control-Allow-Origin',ORIGIN);res.setHeader('Vary','Origin');}
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});return res.end();}
  if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,service:'Binance Demo backend',relayConfigured:!!token&&token.length>=32});
  if(req.method==='GET'&&req.url==='/check-binance'){
   if(now()-probeAt<30000)return send(probe?200:503,probe||{ok:false,error:'Probe pending; retry later'});
   probeAt=now();probe=null;
   try{const upstream=await fetcher(BASE+'/fapi/v1/time',{redirect:'error',signal:AbortSignal.timeout(10000)});const data=await upstream.json();probe={ok:upstream.ok&&Number.isFinite(data.serverTime),upstreamStatus:upstream.status,...(Number.isFinite(data.serverTime)?{serverTime:data.serverTime}:{})};return send(200,probe);}catch{return send(502,{ok:false,error:'Server could not read Binance Demo time. No orders sent.'});}
  }
  if(req.method!=='POST'||req.url!=='/relay')return send(404,{error:'Not found'});
  if(!token||token.length<32)return send(503,{error:'Set a random RELAY_TOKEN of at least 32 characters in Render.'});
  if(!equal(req.headers.authorization,'Bearer '+token))return send(401,{error:'Backend access token rejected'});
  if(now()<cooldown)return send(429,{error:'Binance cooldown; no request forwarded'});
  if(now()-windowAt>=60000){windowAt=now();count=0;}
  if(++count>180||active>=4)return send(429,{error:'Backend rate limit; no request forwarded'});
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(415,{error:'JSON required'});
  let input;
  try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error();}input=JSON.parse(raw);}catch{return send(400,{error:'Invalid request body'});}
  const {method,path,query,apiKey}=input||{};
  if(!routes[method]?.has(path)||typeof query!=='string'||query.length>12000||typeof apiKey!=='string'||!/^[A-Za-z0-9]{16,256}$/.test(apiKey))return send(400,{error:'Unsupported demo request'});
  const params=new URLSearchParams(query);
  if([...params.keys()].some((k,i,all)=>all.indexOf(k)!==i)||!/^\d{13}$/.test(params.get('timestamp')||'')||!/^\d{1,4}$/.test(params.get('recvWindow')||'')||Number(params.get('recvWindow'))>5000||!/^[a-f0-9]{64}$/i.test(params.get('signature')||''))return send(400,{error:'Signed request required'});
  if(Math.abs(now()-Number(params.get('timestamp')))>10000)return send(400,{error:'Request expired; resynchronize time'});
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);active++;
  try{
   const options={method,redirect:'error',signal:ctl.signal,headers:{'X-MBX-APIKEY':apiKey}};
   let url=BASE+path;
   if(method==='POST'){options.headers['Content-Type']='application/x-www-form-urlencoded';options.body=query;}else url+='?'+query;
   const upstream=await fetcher(url,options);
   if([418,429].includes(upstream.status)){cooldown=now()+Math.max(60000,Math.min(3600000,Number(upstream.headers.get('Retry-After')||60)*1000));}
   let data;try{data=await upstream.json();}catch{return send(502,{error:'Unreadable Binance response',uncertain:method!=='GET'});}
   if(!upstream.ok||Number(data?.code)<0)return send(upstream.status>=400?upstream.status:400,{code:Number(data?.code)||upstream.status,msg:'Binance Demo rejected request',uncertain:method!=='GET'&&upstream.status>=500});
   return send(200,data);
  }catch{return send(502,{error:'Binance Demo request failed',uncertain:method!=='GET'});}
  finally{clearTimeout(timer);active--;}
 });
}
if(require.main===module)createServer().listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('Binance Demo backend listening'));
module.exports={createServer};
