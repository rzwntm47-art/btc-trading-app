const fs=require('node:fs');
const path=require('node:path');
const dir=__dirname;
const engine=fs.readFileSync(path.join(dir,'engine.js'),'utf8');
const ui=fs.readFileSync(path.join(dir,'ui.js'),'utf8');
const mobile=fs.readFileSync(path.join(dir,'mobile.js'),'utf8');
const phoneCore=fs.readFileSync(path.join(dir,'phone-link-core.js'),'utf8');
const phoneLink=fs.readFileSync(path.join(dir,'phone-link.js'),'utf8');
const peer=fs.readFileSync(path.join(dir,'vendor/peerjs-1.5.5.min.js'),'utf8');
const template=fs.readFileSync(path.join(dir,'page.html'),'utf8');
new Function(engine);new Function(ui);new Function(mobile);new Function(phoneCore);new Function(phoneLink);new Function(peer);
for(const id of [...(ui+'\n'+mobile+'\n'+phoneLink).matchAll(/\$\('([^']+)'\)/g)].map(x=>x[1]))if(!template.includes('id="'+id+'"'))throw Error('Missing DOM id '+id);
if(engine.includes('https://fapi.binance.com')||engine.includes('https://testnet.binancefuture.com'))throw Error('Unexpected exchange endpoint');
const output=template.replace('/* ENGINE */',()=>engine).replace('/* UI */',()=>ui).replace('/* MOBILE */',()=>mobile).replace('/* PHONE_CORE */',()=>phoneCore).replace('/* PHONE_LINK */',()=>phoneLink).replace('/* PEER */',()=>peer);
fs.writeFileSync(path.join(dir,'demo-connect.html'),output);
console.log('Built demo-connect.html; '+output.length+' characters; syntax and DOM bindings verified.');


