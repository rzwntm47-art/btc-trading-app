'use strict';
const CACHE='btc-dashboard-v1.76-static';
const BASE=new URL('./',self.location.href);
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'].map(path=>new URL(path,BASE).href);
const DEMO=new URL('./demo-connect.html',BASE).href;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'})));
  // Update routing without reloading pages or changing an active trading engine.
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();
  await Promise.all(names.filter(name=>name!==CACHE&&(name==='btc-paper-v17-static'||/^btc-dashboard-v[\d.]+-static$/.test(name))).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);url.search='';url.hash='';
  const key=url.href,asset=ASSETS.includes(key);
  if(!asset&&key!==DEMO)return; // Never intercept/cache account, command or exchange requests.
  event.respondWith((async()=>{
    try{
      const response=await fetch(event.request,{cache:'no-store'});
      if(asset&&response.ok){try{const cache=await caches.open(CACHE);await cache.put(key,response.clone());}catch{}}
      return response;
    }catch{
      if(asset){const cache=await caches.open(CACHE),saved=await cache.match(key);if(saved)return saved;}
      return new Response('Offline: reconnect to load the current dashboard. No trading status is available from this page.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
    }
  })());
});


