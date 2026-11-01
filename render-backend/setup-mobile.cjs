'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DATA_DIR,remoteOrigin}=require('./desktop.cjs');
try{
  const windows=path.join(process.env.ProgramFiles||'C:\\Program Files','Tailscale','tailscale.exe');
  const command=process.platform==='win32'&&fs.existsSync(windows)?windows:'tailscale';
  const status=spawnSync(command,['status','--json'],{encoding:'utf8'});
  if(status.error||status.status!==0)throw Error('Install Tailscale on this laptop and your phone, sign in to the same private network, and connect both. Then run ENABLE-MOBILE.cmd again.');
  const state=JSON.parse(status.stdout);
  if(state.BackendState!=='Running'||!state.Self?.DNSName)throw Error('Tailscale is not connected. Sign in and connect it, then try again.');
  const origin=remoteOrigin('https://'+state.Self.DNSName.replace(/\.$/,''));
  const existing=spawnSync(command,['serve','status','--json'],{encoding:'utf8'});
  if(existing.status!==0)throw Error('Cannot inspect existing Tailscale sharing. On Windows, right-click ENABLE-MOBILE.cmd and choose Run as administrator.');
  const config=JSON.parse(existing.stdout||'{}');
  for(const [host,web] of Object.entries(config.Web||{}))if(host.endsWith(':443')){
    for(const [route,handler] of Object.entries(web.Handlers||{}))if(route!=='/'||handler.Proxy!=='http://127.0.0.1:10000')throw Error('Port 443 is already sharing another service. Nothing was changed. Use a dedicated device or review the existing Serve configuration first.');
  }
  if(config.AllowFunnel&&Object.values(config.AllowFunnel).some(Boolean))throw Error('Public Funnel sharing is enabled. Disable it before enabling private mobile trading. Nothing was changed.');
  console.log('Enabling private HTTPS access for devices on your Tailscale network only.');
  console.log('If an HTTPS approval link appears, open it and approve, then rerun this file if needed.');
  const result=spawnSync(command,['serve','--bg','--https=443','http://127.0.0.1:10000'],{stdio:'inherit'});
  if(result.status!==0)throw Error('Tailscale Serve did not finish. Follow the message above. On Windows, right-click this file and choose Run as administrator if permission is required.');
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});fs.writeFileSync(path.join(DATA_DIR,'mobile-origin.json'),JSON.stringify({origin}),{mode:0o600});
  console.log('\nPrivate laptop address — paste this in Pair Mobile:\n'+origin);
  console.log('\nKeep Tailscale connected on your phone. No Run command is needed there.');
}catch(error){console.error(error.message);process.exitCode=1;}
