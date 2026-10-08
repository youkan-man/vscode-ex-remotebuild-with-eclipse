import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

type Archive = { source: string; destination: string; stripComponents?: number };
type Profile = {
  name: string;
  project: string;
  configuration: string;
  eclipseWorkspace: string;
  eclipseExecutable: string;
  imports: string[];
  extraArgs: string[];
  environment: Record<string,string>;
};
type Settings = {
  ssh: { host: string; port: number; user: string; identityFile: string };
  remote: { root: string; container: string; dockerCommand: string };
  sync: { include: string[]; exclude: string[]; profileFiles: string[] };
  provision: { baseImage: string; image: string; dockerfile: string; archives: Archive[] };
  profiles: Profile[];
};
const defaults: Settings = {
  ssh: { host: '', port: 22, user: '', identityFile: '' },
  remote: { root: '/srv/eclipse-remote-build', container: 'eclipse-builder', dockerCommand: 'docker' },
  sync: { include: ['.'], exclude: ['.git/', '.vscode-test/', 'node_modules/', 'dist/', '*.o', '*.a'], profileFiles: [] },
  provision: { baseImage: 'ubuntu:24.04', image: 'eclipse-builder:local', dockerfile: 'docker/Dockerfile', archives: [] },
  profiles: [{
    name: 'Debug', project: 'MyProject', configuration: 'Debug',
    eclipseWorkspace: '/tmp/eclipse-workspace', eclipseExecutable: '/opt/eclipse/eclipse',
    imports: ['.'], extraArgs: [], environment: {}
  }]
};
const output = vscode.window.createOutputChannel('Eclipse Remote Build');
function quote(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function safeRel(s: string): string {
  if (!s || path.posix.isAbsolute(s.replace(/\\/g, '/')) || /^[A-Za-z]:/.test(s)) throw Error('Workspace-relative path required: '+s);
  const p = path.posix.normalize(s.replace(/\\/g, '/'));
  if (p === '..' || p.startsWith('../')) throw Error('Path escapes workspace: '+s);
  return p;
}
function absWorkspace(root: string, rel: string): string {
  return path.resolve(root, safeRel(rel));
}
function validate(s: Settings): void {
  if (!s.ssh.host || !/^[a-zA-Z0-9_.:-]+$/.test(s.ssh.host)) throw Error('Invalid SSH host');
  if (s.ssh.user && !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(s.ssh.user)) throw Error('Invalid SSH user');
  if (!Number.isInteger(s.ssh.port) || s.ssh.port<1 || s.ssh.port>65535) throw Error('Invalid SSH port');
  if (!s.remote.root.startsWith('/') || s.remote.root === '/') throw Error('Remote root must be an absolute, non-root path');
  if (!/^[a-zA-Z0-9_.-]+$/.test(s.remote.container)) throw Error('Invalid container name');
  if (!/^[a-zA-Z0-9_./-]+$/.test(s.remote.dockerCommand)) throw Error('dockerCommand must be a command path');
  s.sync.include.forEach(safeRel); s.sync.exclude.forEach(x => {if (x.startsWith('/') || x.includes('..')) throw Error('Unsafe exclude: '+x);});
  s.sync.profileFiles.forEach(safeRel);
  for (const a of s.provision.archives) {
    safeRel(a.source);
    if (!a.destination.startsWith('/') || a.destination.includes('..')) throw Error('Archive destination must be an absolute container path');
    if (a.stripComponents !== undefined && (!Number.isInteger(a.stripComponents) || a.stripComponents < 0)) throw Error('Invalid stripComponents');
  }
  s.profiles.forEach(p => {
    if (!p.name || !p.project || !p.configuration) throw Error('Profile name, project, configuration required');
    p.imports.forEach(safeRel);
    if (!p.eclipseWorkspace.startsWith('/') || !p.eclipseExecutable.startsWith('/')) throw Error('Eclipse executable and workspace must be absolute paths in container');
  });
}
function workspace(): vscode.WorkspaceFolder {
  const all = vscode.workspace.workspaceFolders;
  if (!all?.length) throw Error('Open a folder in VS Code first');
  if (all.length > 1) throw Error('Select a single-root workspace for now');
  if (all[0].uri.scheme !== 'file') throw Error('Local filesystem workspace required');
  return all[0];
}
function configPath(folder: vscode.WorkspaceFolder): string {
  return absWorkspace(folder.uri.fsPath, vscode.workspace.getConfiguration('eclipseRemote').get('configFile', '.vscode/eclipse-remote-build.json'));
}
async function load(folder: vscode.WorkspaceFolder): Promise<Settings> {
  try { return JSON.parse(await fs.readFile(configPath(folder), 'utf8')) as Settings; }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaults); throw e; }
}
async function save(folder: vscode.WorkspaceFolder, data: Settings): Promise<void> {
  validate(data);
  const dest=configPath(folder);
  await fs.mkdir(path.dirname(dest), {recursive:true});
  await fs.writeFile(dest, JSON.stringify(data,null,2)+'\n');
}
function sshArgs(s: Settings): string[] {
  const args=['-p',String(s.ssh.port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes'];
  if (s.ssh.identityFile) args.push('-i',s.ssh.identityFile);
  return args;
}
function target(s: Settings): string {return (s.ssh.user ? s.ssh.user+'@' : '')+s.ssh.host;}
function execute(cmd: string, args: string[], cwd: string, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve,reject) => {
    output.appendLine('$ '+[cmd,...args].map(a => /password|token/i.test(a)?'[masked]':quote(a)).join(' '));
    const child=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false});
    const cancel=token?.onCancellationRequested(()=>child.kill());
    child.stdout.on('data',(b:Buffer)=>output.append(b.toString()));
    child.stderr.on('data',(b:Buffer)=>output.append(b.toString()));
    child.on('error',e=>{cancel?.dispose();reject(e);});
    child.on('close',(code,signal)=>{cancel?.dispose();code===0?resolve():reject(Error(cmd+' failed (exit '+code+', signal '+signal+')'));});
  });
}
async function ssh(s:Settings, root:string, command:string, token?:vscode.CancellationToken):Promise<void> {
  await execute('ssh',[...sshArgs(s),target(s),command],root,token);
}
async function synchronize(s:Settings, root:string, token?:vscode.CancellationToken):Promise<void> {
  validate(s);
  const remote=s.remote.root.replace(/\/$/,'');
  await ssh(s,root,'mkdir -p '+quote(remote),token);
  const sshCmd=['ssh','-p',String(s.ssh.port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    ...(s.ssh.identityFile?['-i',s.ssh.identityFile]:[])].map(quote).join(' ');
  const base=['-az','--checksum','--protect-args','--relative','-e',sshCmd];
  const paths=[...new Set([...s.sync.include,...s.sync.profileFiles].map(safeRel))];
  for(const rel of paths){
    const local=absWorkspace(root,rel);
    await fs.stat(local); // reject missing inputs
    const args=[...base,...s.sync.exclude.flatMap(x=>['--exclude',x]),rel,target(s)+':'+remote+'/'];
    await execute('rsync',args,root,token);
  }
}
function containerPath(s:Settings,rel:string):string {
  return '/workspace/'+safeRel(rel).replace(/^\.\/?/,'');
}
async function build(s:Settings, p:Profile, root:string, token?:vscode.CancellationToken):Promise<void>{
  const docker=s.remote.dockerCommand;
  const args=[
    'exec',...Object.entries(p.environment).flatMap(([k,v])=>{
      if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) throw Error('Invalid environment key: '+k);
      return ['-e',k+'='+v];
    }),s.remote.container,p.eclipseExecutable,
    '-nosplash','-application','org.eclipse.cdt.managedbuilder.core.headlessbuild',
    '-data',p.eclipseWorkspace,
    ...p.imports.flatMap(x=>['-importAll',containerPath(s,x)]),
    '-build',p.project+'/'+p.configuration,...p.extraArgs
  ];
  const cmd=[docker,...args].map(quote).join(' ');
  await ssh(s,root,cmd,token);
}
async function provision(s:Settings,root:string,token?:vscode.CancellationToken):Promise<void>{
  // Archive list is resolved relative to workspace and uploaded by rsync. Dockerfile is workspace-local.
  const paths=[...s.provision.archives.map(a=>a.source),s.provision.dockerfile].map(safeRel);
  await ssh(s,root,'mkdir -p '+quote(s.remote.root),token);
  const sshCmd=['ssh','-p',String(s.ssh.port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    ...(s.ssh.identityFile?['-i',s.ssh.identityFile]:[])].map(quote).join(' ');
  for(const rel of paths){
    await fs.stat(absWorkspace(root,rel));
    await execute('rsync',['-az','--checksum','--relative','-e',sshCmd,rel,target(s)+':'+s.remote.root+'/'],root,token);
  }
  const args=[s.remote.dockerCommand,'build','-f',s.remote.root+'/'+safeRel(s.provision.dockerfile),
    '-t',s.provision.image,'--build-arg','BASE_IMAGE='+s.provision.baseImage,s.remote.root];
  await ssh(s,root,args.map(quote).join(' '),token);
}
async function operation(action:'build'|'sync'|'provision') {
  const folder=workspace(),s=await load(folder);
  validate(s);
  let profile:Profile|undefined;
  if(action==='build'){
    const chosen=await vscode.window.showQuickPick(s.profiles.map(p=>p.name),{placeHolder:'Select Eclipse build profile'});
    if(!chosen) return;
    profile=s.profiles.find(p=>p.name===chosen);
  }
  output.show(true);
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Eclipse Remote Build: '+action,cancellable:true},async(_progress,token)=>{
    if(action==='provision') await provision(s,folder.uri.fsPath,token);
    else { await synchronize(s,folder.uri.fsPath,token);if(profile)await build(s,profile,folder.uri.fsPath,token); }
  });
  vscode.window.showInformationMessage('Eclipse Remote Build: '+action+' completed');
}
function page(data:Settings):string {
  const nonce=Math.random().toString(36).slice(2);
  const json=JSON.stringify(data).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
  :root{color-scheme:light dark}body{font:13px var(--vscode-font-family);padding:20px;max-width:1050px;margin:auto;color:var(--vscode-foreground)}
  h1{font-size:22px}h2{font-size:15px;margin-top:0}section{border:1px solid var(--vscode-panel-border);padding:16px;margin:14px 0;border-radius:5px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.field{display:flex;flex-direction:column;gap:5px}
  label{font-weight:600}input,textarea{font:inherit;box-sizing:border-box;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:7px}
  button{padding:8px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer;margin-right:8px}
  .secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .toolbar{position:sticky;top:0;padding:10px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);z-index:1}
  .hint{opacity:.75;margin:6px 0 12px}textarea{min-height:65px}#error{color:var(--vscode-errorForeground);white-space:pre-wrap}
  </style></head><body><h1>Eclipse Remote Build</h1><p class="hint">Workspace-relative paths for sync, imports, archives and Dockerfile. One entry per line for lists.</p>
  <div class="toolbar"><button id="save">Save configuration</button><button id="sync">Sync</button><button id="build">Sync &amp; Build</button><button id="provision">Provision image</button><span id="error"></span></div>
  <main id="app"></main>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi();let data=${json};
  const app=document.getElementById('app');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function field(label,path,type='text'){let value=path.split('.').reduce((o,k)=>o?.[k],data)??'';return '<div class="field"><label>'+esc(label)+'</label><input data-path="'+esc(path)+'" type="'+type+'" value="'+esc(value)+'"></div>'}
  function list(label,path){let arr=path.split('.').reduce((o,k)=>o?.[k],data)||[];return '<div class="field"><label>'+esc(label)+'</label><textarea data-list="'+esc(path)+'">'+esc(arr.join('\\n'))+'</textarea></div>'}
  function set(path,value){let keys=path.split('.'),cur=data;for(let i=0;i<keys.length-1;i++)cur=cur[keys[i]];cur[keys.at(-1)]=value}
  function draw(){
   app.innerHTML='<section><h2>SSH destination</h2><div class="grid">'+field('Host','ssh.host')+field('Username','ssh.user')+field('Port','ssh.port','number')+field('SSH identity file (local)','ssh.identityFile')+'</div></section>'+
   '<section><h2>Remote Docker environment</h2><div class="grid">'+field('Host workspace path','remote.root')+field('Container name','remote.container')+field('Docker executable','remote.dockerCommand')+'</div></section>'+
   '<section><h2>Incremental transfer</h2><div class="grid">'+list('Include paths','sync.include')+list('Exclude patterns','sync.exclude')+list('Workspace profile files','sync.profileFiles')+'</div></section>'+
   '<section><h2>Container image provisioning</h2><div class="grid">'+field('Base image','provision.baseImage')+field('Image tag','provision.image')+field('Dockerfile (workspace relative)','provision.dockerfile')+'</div><div id="archives"></div><button class="secondary" id="addArchive">+ Archive</button></section>'+
   '<section><h2>Build profiles</h2><div id="profiles"></div><button class="secondary" id="addProfile">+ Profile</button></section>';
   drawLists();
  }
  function drawLists(){
   document.getElementById('archives').innerHTML=data.provision.archives.map((a,i)=>'<div class="grid" style="margin:12px 0"><div class="field"><label>Archive '+(i+1)+' (relative)</label><input data-archive="'+i+'" data-key="source" value="'+esc(a.source)+'"></div><div class="field"><label>Unpack destination (container)</label><input data-archive="'+i+'" data-key="destination" value="'+esc(a.destination)+'"></div><div class="field"><label>Strip components</label><input type="number" min="0" data-archive="'+i+'" data-key="stripComponents" value="'+esc(a.stripComponents??0)+'"></div><button class="secondary" data-remove-archive="'+i+'">Remove</button></div>').join('');
   document.getElementById('profiles').innerHTML=data.profiles.map((p,i)=>'<article style="border-top:1px solid var(--vscode-panel-border);margin:14px 0;padding-top:14px"><div class="grid">'+
    ['name','project','configuration','eclipseWorkspace','eclipseExecutable'].map(k=>'<div class="field"><label>'+esc(k)+'</label><input data-profile="'+i+'" data-key="'+k+'" value="'+esc(p[k])+'"></div>').join('')+
    ['imports','extraArgs'].map(k=>'<div class="field"><label>'+esc(k)+' (one per line)</label><textarea data-profile="'+i+'" data-key="'+k+'" data-kind="list">'+esc(p[k].join('\\n'))+'</textarea></div>').join('')+
    '<div class="field"><label>Environment (JSON object)</label><textarea data-profile="'+i+'" data-key="environment" data-kind="json">'+esc(JSON.stringify(p.environment,null,2))+'</textarea></div></div><button class="secondary" data-remove-profile="'+i+'">Remove profile</button></article>').join('');
  }
  app.addEventListener('input',e=>{
   let t=e.target;if(t.dataset.path)set(t.dataset.path,t.type==='number'?Number(t.value):t.value);
   if(t.dataset.list)set(t.dataset.list,t.value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean));
   if(t.dataset.archive!==undefined){let k=t.dataset.key;data.provision.archives[Number(t.dataset.archive)][k]=k==='stripComponents'?Number(t.value):t.value;}
   if(t.dataset.profile!==undefined){let k=t.dataset.key,p=data.profiles[Number(t.dataset.profile)];if(t.dataset.kind==='list')p[k]=t.value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);else if(t.dataset.kind==='json'){try{p[k]=JSON.parse(t.value);document.getElementById('error').textContent=''}catch(e){document.getElementById('error').textContent=e.message}}else p[k]=t.value;}
  });
  app.addEventListener('click',e=>{let t=e.target;if(t.id==='addArchive')data.provision.archives.push({source:'toolchain.tar.gz',destination:'/opt/toolchain',stripComponents:0});else if(t.id==='addProfile')data.profiles.push({name:'Release',project:'MyProject',configuration:'Release',eclipseWorkspace:'/tmp/eclipse-workspace',eclipseExecutable:'/opt/eclipse/eclipse',imports:['.'],extraArgs:[],environment:{}});else if(t.dataset.removeArchive!==undefined)data.provision.archives.splice(Number(t.dataset.removeArchive),1);else if(t.dataset.removeProfile!==undefined)data.profiles.splice(Number(t.dataset.removeProfile),1);else return;drawLists();});
  for(const act of ['save','sync','build','provision'])document.getElementById(act).addEventListener('click',()=>vscode.postMessage({action:act,data}));
  window.addEventListener('message',e=>{document.getElementById('error').textContent=e.data.error??e.data.info??''});
  draw();
  </script></body></html>`;
}
export function activate(context:vscode.ExtensionContext){
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.configure',async()=>{
    try{
      const folder=workspace(),panel=vscode.window.createWebviewPanel('eclipseRemote','Eclipse Remote Build',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true});
      panel.webview.html=page(await load(folder));
      panel.webview.onDidReceiveMessage(async(msg:{action:string;data:Settings})=>{
        try{
          await save(folder,msg.data);
          panel.webview.postMessage({info:'Configuration saved'});
          if(['sync','build','provision'].includes(msg.action))await operation(msg.action as 'sync'|'build'|'provision');
        }catch(e){panel.webview.postMessage({error:String(e)});vscode.window.showErrorMessage(String(e));}
      });
    }catch(e){vscode.window.showErrorMessage(String(e));}
  }));
  for(const action of ['build','sync','provision'] as const){
    context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.'+action,async()=>{
      try{await operation(action);}catch(e){output.show(true);vscode.window.showErrorMessage(String(e));}
    }));
  }
}
export function deactivate(){}
