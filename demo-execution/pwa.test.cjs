'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const ROOT='https://rzwntm47-art.github.io/btc-trading-app/';
function worker({offline=false}={}){
 const events={},stores=new Map(),calls=[],deleted=[];let claimed=0,activated=0;
 const caches={async keys(){return [...stores.keys()];},async delete(key){deleted.push(key);return stores.delete(key);},async open(name){if(!stores.has(name))stores.set(name,new Map());const data=stores.get(name);return {async addAll(requests){for(const request of requests){calls.push(request);data.set(request.url,new Response('initial'));}},async put(key,response){data.set(key,response);},async match(key){return data.get(key)?.clone();}};}};
 const self={location:{href:ROOT+'sw.js',origin:new URL(ROOT).origin},addEventListener(name,fn){events[name]=fn;},async skipWaiting(){activated++;},clients:{async claim(){claimed++;}}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/../sw.js','utf8'),{self,caches,URL,Request,Response,fetch:async(request,options)=>{calls.push({url:request.url,options});if(offline)throw Error('offline');return new Response('fresh');}});
 const lifecycle=async name=>{let work;events[name]({waitUntil(p){work=p;}});await work;};
 const request=async(url,method='GET')=>{let response;events.fetch({request:new Request(url,{method}),respondWith(p){response=p;}});return response===undefined?undefined:await response;};
 return {stores,calls,deleted,lifecycle,request,setOffline(value){offline=value;},get claimed(){return claimed;},get activated(){return activated;}};
}
test('PWA update removes only old app static caches and activates without reloading clients',async()=>{
 const w=worker();w.stores.set('btc-paper-v17-static',new Map());w.stores.set('unrelated-app',new Map());w.stores.set('btc-dashboard-v1.63-static',new Map());
 await w.lifecycle('install');await w.lifecycle('activate');assert.equal(w.activated,1);assert.equal(w.claimed,1);assert.deepEqual(w.deleted,['btc-paper-v17-static','btc-dashboard-v1.63-static']);assert.ok(w.stores.has('unrelated-app'));assert.ok(w.stores.has('btc-dashboard-v1.69-static'));assert.ok(w.calls.every(r=>r.cache==='reload'));
});
test('PWA retrieves current version and refreshes only the public static cache',async()=>{
 const w=worker();await w.lifecycle('install');const response=await w.request(ROOT+'index.html?v=1.69');assert.equal(await response.text(),'fresh');assert.equal(w.calls.at(-1).options.cache,'no-store');
 w.setOffline(true);const fallback=await w.request(ROOT+'index.html?v=1.69');assert.equal(await fallback.text(),'fresh');
});
test('PWA never serves a cached execution page or intercepts commands and account reads',async()=>{
 const w=worker();await w.lifecycle('install');const old=w.stores.get('btc-dashboard-v1.69-static');old.set(ROOT+'demo-connect.html',new Response('stale engine'));
 assert.equal(await (await w.request(ROOT+'demo-connect.html?v=1.69')).text(),'fresh');assert.equal(await old.get(ROOT+'demo-connect.html').clone().text(),'stale engine');
 w.setOffline(true);const unavailable=await w.request(ROOT+'demo-connect.html?v=1.69');assert.equal(unavailable.status,503);assert.match(await unavailable.text(),/Offline/);
 for(const url of [ROOT+'mobile/status',ROOT+'host/status','https://demo-fapi.binance.com/fapi/v3/account','http://127.0.0.1:10000/host/status'])assert.equal(await w.request(url),undefined);
 assert.equal(await w.request(ROOT+'host/command','POST'),undefined);
});
test('installed app retains its launch identity and no longer labels itself V17',()=>{
 const manifest=JSON.parse(fs.readFileSync(__dirname+'/../manifest.webmanifest','utf8'));assert.equal(manifest.start_url,'./index.html');assert.equal(manifest.scope,'./');assert.equal(manifest.short_name,'Binance Demo');assert.ok(!/V17/.test(manifest.name));
});

