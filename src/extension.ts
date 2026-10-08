import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';

type Archive = { source: string; destination: string; stripComponents?: number };
type Profile = { name: string; profileFile?: string; project: string; configuration: string; eclipseWorkspace: string; eclipseExecutable: string; imports: string[]; extraArgs: string[]; environment: Record<string,string> };
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
  sync: { include: ['.'], exclude: ['.git/', '.local_relay/', '.vscode-test/', 'node_modules/', 'dist/', '*.o', '*.a'], profileFiles: [] },
  provision: { baseImage: 'ubuntu:24.04', image: 'eclipse-builder:local', dockerfile: '', archives: [] },
  profiles: [{ name: 'Debug', profileFile: '', project: 'MyProject', configuration: 'Debug', eclipseWorkspace: '/tmp/eclipse-workspace', eclipseExecutable: '/opt/eclipse/eclipse', imports: ['.'], extraArgs: [], environment: {} }]
};
const output = vscode.window.createOutputChannel('Eclipse Remote Build');
let busy = false;
function quote(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function text(s: unknown): s is string { return typeof s === 'string' && !/[\x00-\x1f]/.test(s); }
function safeRel(s: string): string {
  if (!text(s) || !s || path.posix.isAbsolute(s.replace(/\\/g,'/')) || /^[A-Za-z]:/.test(s)) throw Error('Workspace-relative path required: '+s);
  const p=path.posix.normalize(s.replace(/\\/g,'/'));
  if (p==='..' || p.startsWith('../')) throw Error('Path escapes workspace: '+s);
  return p;
}
function absWorkspace(root: string, rel: string): string { return path.resolve(root,safeRel(rel)); }
function remoteAbsolute(s: string): boolean { return text(s) && s.startsWith('/') && !s.split('/').includes('..'); }
function validateProfile(p: Profile): void {
  if (!p || !text(p.name) || !p.name || !text(p.project) || !p.project || !text(p.configuration) || !p.configuration) throw Error('Profile name, project and configuration are required');
  if (!Array.isArray(p.imports) || !Array.isArray(p.extraArgs) || !p.extraArgs.every(text)) throw Error('imports and extraArgs must be string arrays');
  p.imports.forEach(safeRel);
  if (p.profileFile) safeRel(p.profileFile);
  if (!remoteAbsolute(p.eclipseWorkspace) || !remoteAbsolute(p.eclipseExecutable)) throw Error('Eclipse paths must be absolute container paths');
  if (!p.environment || Array.isArray(p.environment) || typeof p.environment!=='object') throw Error('Environment must be a JSON object');
  for (const [k,v] of Object.entries(p.environment)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v!=='string' || v.includes('\0')) throw Error('Environment entries must have valid names and string values');
}
function validate(s: Settings, execution=true): void {
  if (!s?.ssh || !s.remote || !s.sync || !s.provision || !Array.isArray(s.profiles)) throw Error('Invalid Eclipse Remote Build settings');
  if ((execution || s.ssh.host) && !(isIP(s.ssh.host) || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s.ssh.host))) throw Error('Invalid SSH host');
  if (s.ssh.user && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s.ssh.user)) throw Error('Invalid SSH user');
  if (!Number.isInteger(s.ssh.port) || s.ssh.port<1 || s.ssh.port>65535) throw Error('Invalid SSH port');
  if (!text(s.ssh.identityFile)) throw Error('Invalid SSH identity file');
  if (!remoteAbsolute(s.remote.root) || path.posix.normalize(s.remote.root)==='/') throw Error('Remote root must be an absolute, non-root path');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s.remote.container) || !/^(?:\/[A-Za-z0-9_./-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(s.remote.dockerCommand)) throw Error('Invalid Docker container or executable');
  for (const key of ['include','exclude','profileFiles'] as const) if (!Array.isArray(s.sync[key]) || !s.sync[key].every(text)) throw Error('Invalid transfer list: '+key);
  s.sync.include.forEach(safeRel); s.sync.profileFiles.forEach(safeRel);
  if (!text(s.provision.baseImage) || !s.provision.baseImage || !text(s.provision.image) || !s.provision.image || /\s/.test(s.provision.image+s.provision.baseImage)) throw Error('Invalid image name');
  if (s.provision.dockerfile) safeRel(s.provision.dockerfile);
  if (!Array.isArray(s.provision.archives)) throw Error('Invalid archive list');
  for (const a of s.provision.archives) {
    const rel=safeRel(a.source);
    if (rel==='.' || rel.startsWith('.erb-') || !/\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|txz|tbz2|zip)$/i.test(rel)) throw Error('Select a TAR or ZIP archive: '+rel);
    if (!remoteAbsolute(a.destination) || path.posix.normalize(a.destination)==='/') throw Error('Archive destination must be a non-root container directory');
    if (a.stripComponents!==undefined && (!Number.isInteger(a.stripComponents) || a.stripComponents<0)) throw Error('Invalid stripComponents');
  }
  s.profiles.forEach(validateProfile);
  if (new Set(s.profiles.map(p=>p.name)).size!==s.profiles.length) throw Error('Profile names must be unique');
}
function workspace(): vscode.WorkspaceFolder {
  const all=vscode.workspace.workspaceFolders;
  if (all?.length!==1 || all[0].uri.scheme!=='file') throw Error('Open one filesystem workspace folder');
  return all[0];
}
function configPath(folder: vscode.WorkspaceFolder): string { return absWorkspace(folder.uri.fsPath,vscode.workspace.getConfiguration('eclipseRemote',folder.uri).get('configFile','.vscode/eclipse-remote-build.json')); }
async function load(folder: vscode.WorkspaceFolder): Promise<Settings> {
  try { const s=JSON.parse(await fs.readFile(configPath(folder),'utf8')) as Settings; validate(s,false); return s; }
  catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return structuredClone(defaults); throw e; }
}
async function save(folder: vscode.WorkspaceFolder, data: Settings): Promise<void> {
  validate(data,false); const dest=configPath(folder);
  await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,JSON.stringify(data,null,2)+'\n');
}
function sshArgs(s: Settings, root=process.cwd()): string[] {
  const args=['-p',String(s.ssh.port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3'];
  if (s.ssh.identityFile) { let key=s.ssh.identityFile; if (key.startsWith('~/')) key=path.join(os.homedir(),key.slice(2)); else if (!path.isAbsolute(key)) key=absWorkspace(root,key); args.push('-i',key); }
  return args;
}
function target(s: Settings): string { return (s.ssh.user?s.ssh.user+'@':'')+s.ssh.host; }
function execute(cmd: string,args: string[],cwd: string,token?: vscode.CancellationToken,capture=false): Promise<string> {
  if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
  return new Promise((resolve,reject)=>{
    output.appendLine('$ '+(cmd==='ssh'?'ssh [remote command]':[cmd,...args].map(quote).join(' ')));
    const child=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false}); let collected=''; let cancelled=false;
    const cancel=token?.onCancellationRequested(()=>{cancelled=true; child.kill();});
    child.stdout.on('data',(b: Buffer)=>{ if (capture) collected=(collected+b.toString()).slice(-1024*1024); else output.append(b.toString()); });
    child.stderr.on('data',(b: Buffer)=>output.append(b.toString()));
    child.once('error',e=>{cancel?.dispose(); reject(e);});
    child.once('close',(code,signal)=>{cancel?.dispose(); if (cancelled) reject(new vscode.CancellationError()); else if(code===0) resolve(collected); else reject(Error(cmd+' failed (exit '+code+', signal '+signal+')'));});
  });
}
async function ssh(s: Settings,root: string,command: string,token?: vscode.CancellationToken,capture=false): Promise<string> { return execute('ssh',[...sshArgs(s,root),target(s),command],root,token,capture); }
async function transfer(s: Settings,root: string,paths: string[],remote: string,exclude: string[],token?: vscode.CancellationToken): Promise<void> {
  const shell=['ssh',...sshArgs(s,root)].map(quote).join(' ');
  const host=s.ssh.host.includes(':')?'['+s.ssh.host+']':s.ssh.host;
  const destination=(s.ssh.user?s.ssh.user+'@':'')+host+':'+remote+'/';
  const base=await fs.realpath(root);
  for (const rel of [...new Set(paths.map(safeRel))]) {
    const real=await fs.realpath(absWorkspace(root,rel)); const inside=path.relative(base,real);
    if (inside==='..' || inside.startsWith('..'+path.sep) || path.isAbsolute(inside)) throw Error('Source escapes workspace through symlink: '+rel);
    await execute('rsync',['-az','--checksum','--safe-links','--protect-args','--relative','--itemize-changes','-e',shell,...exclude.flatMap(x=>['--exclude',x]),'--','./'+rel,destination],root,token);
  }
}
async function synchronize(s: Settings,root: string,token?: vscode.CancellationToken): Promise<void> {
  validate(s); const remote=path.posix.normalize(s.remote.root).replace(/\/$/,'');
  await ssh(s,root,'mkdir -p -- '+quote(remote),token);
  await transfer(s,root,s.sync.include,remote,s.sync.exclude,token);
  await transfer(s,root,[...s.sync.profileFiles,...s.profiles.flatMap(p=>p.profileFile?[p.profileFile]:[])],remote,[],token);
}
function containerPath(_s: Settings,rel: string): string { const p=safeRel(rel); return p==='.'?'/workspace/':'/workspace/'+p; }
async function resolveProfile(p: Profile,root: string): Promise<Profile> {
  if (!p.profileFile) return p;
  const file=JSON.parse(await fs.readFile(absWorkspace(root,p.profileFile),'utf8'));
  if (!file || typeof file!=='object' || Array.isArray(file)) throw Error('Build profile file must contain a JSON object');
  const result={...p,...file,name:p.name,profileFile:p.profileFile} as Profile; validateProfile(result); return result;
}
async function build(s: Settings,profile: Profile,root: string,token?: vscode.CancellationToken): Promise<void> {
  const p=await resolveProfile(profile,root); validateProfile(p);
  const expand=(v:string)=>v.replace(/\$\{workspaceFolder\}/g,'/workspace');
  const args=[s.remote.dockerCommand,'exec','-w','/workspace',...Object.entries(p.environment).flatMap(([k,v])=>['-e',k+'='+expand(v)]),s.remote.container,p.eclipseExecutable,'-nosplash','-application','org.eclipse.cdt.managedbuilder.core.headlessbuild','-data',p.eclipseWorkspace,...p.imports.flatMap(x=>['-importAll',containerPath(s,x)]),'-build',p.project+'/'+p.configuration,...p.extraArgs.map(expand)];
  output.appendLine('Eclipse: '+p.project+' / '+p.configuration);
  await ssh(s,root,args.map(quote).join(' '),token);
}
async function provision(s: Settings,root: string,token?: vscode.CancellationToken): Promise<void> {
  validate(s);
  const bundled=path.resolve(__dirname,'../docker');
  const base=await fs.readFile(s.provision.dockerfile?absWorkspace(root,s.provision.dockerfile):path.join(bundled,'Dockerfile'),'utf8');
  const tag=createHash('sha256').update(JSON.stringify([root,s.provision,base])).digest('hex').slice(0,16);
  const remote=path.posix.normalize(s.remote.root).replace(/\/$/,'')+'.erb-context/'+tag;
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'eclipse-image-'));
  try {
    const manifest=s.provision.archives.map((a,i)=>({...a,source:String(i)+'/'+path.posix.basename(safeRel(a.source))}));
    const copy=s.provision.archives.map((a,i)=>'COPY '+JSON.stringify([safeRel(a.source),'/tmp/.erb-archives/'+manifest[i].source])).join('\n');
    const dockerfile=base+'\nUSER root\nCOPY [".erb-install.py", "/tmp/.erb-install.py"]\nCOPY [".erb-archives.json", "/tmp/.erb-archives.json"]\n'+copy+'\nRUN python3 /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives && rm -rf /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives\nWORKDIR /workspace\nCMD ["sleep", "infinity"]\n';
    await fs.writeFile(path.join(temp,'.erb-Dockerfile'),dockerfile);
    await fs.writeFile(path.join(temp,'.erb-archives.json'),JSON.stringify(manifest));
    await fs.copyFile(path.join(bundled,'install-archives.py'),path.join(temp,'.erb-install.py'));
    await ssh(s,root,'mkdir -p -- '+quote(remote),token);
    const upload=structuredClone(s);
    if (upload.ssh.identityFile && !path.isAbsolute(upload.ssh.identityFile) && !upload.ssh.identityFile.startsWith('~/')) upload.ssh.identityFile=absWorkspace(root,upload.ssh.identityFile);
    await transfer(upload,temp,['.'],remote,[],token);
    await transfer(s,root,s.provision.archives.map(a=>a.source),remote,[],token);
    await ssh(s,root,[s.remote.dockerCommand,'build','-f',remote+'/.erb-Dockerfile','--build-arg','BASE_IMAGE='+s.provision.baseImage,'-t',s.provision.image,remote].map(quote).join(' '),token);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}
async function startContainer(s: Settings,root: string,token?: vscode.CancellationToken,replace=false): Promise<boolean> {
  const docker=(args:string[],capture=false)=>ssh(s,root,[s.remote.dockerCommand,...args].map(quote).join(' '),token,capture);
  const names=(await docker(['container','ls','-a','--format','{{.Names}}'],true)).trim().split(/\r?\n/);
  if (names.includes(s.remote.container)) {
    const [c]=JSON.parse(await docker(['container','inspect',s.remote.container],true));
    const image=(await docker(['image','inspect','--format','{{.Id}}',s.provision.image],true)).trim();
    const mount=c.Mounts?.find((m:{Destination:string})=>m.Destination==='/workspace');
    if (c.Image===image && mount?.Source===path.posix.normalize(s.remote.root).replace(/\/$/,'')) { if(!c.State.Running) await docker(['start',s.remote.container]); return true; }
    if (!replace) return false;
    await docker(['rm','-f',s.remote.container]);
  }
  await ssh(s,root,'mkdir -p -- '+quote(s.remote.root),token);
  const source=path.posix.normalize(s.remote.root).replace(/\/$/,'');
  const mount='type=bind,"source='+source.replace(/"/g,'""')+'",target=/workspace';
  await docker(['run','-d','--name',s.remote.container,'--label','eclipse-remote-build=managed','--mount',mount,'-w','/workspace',s.provision.image]);
  return true;
}
type Action='build'|'sync'|'provision';
async function operation(action: Action,folder=workspace(),selectedName?: string): Promise<void> {
  if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before running remote commands');
  if (busy) throw Error('An Eclipse Remote Build operation is already running');
  const s=await load(folder); validate(s); let profile: Profile|undefined;
  if (action==='build') {
    const name=selectedName || await vscode.window.showQuickPick(s.profiles.map(p=>p.name),{placeHolder:'Select Eclipse build profile'});
    if (!name) return; profile=s.profiles.find(p=>p.name===name); if(!profile) throw Error('Build profile not found');
    await resolveProfile(profile,folder.uri.fsPath);
  }
  busy=true; output.show(true);
  try {
    await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Eclipse Remote Build: '+action,cancellable:true},async(_progress,token)=>{
      if (action==='provision') {
        await provision(s,folder.uri.fsPath,token);
        if (!await startContainer(s,folder.uri.fsPath,token)) {
          const choice=await vscode.window.showWarningMessage('コンテナのイメージまたはマウントが異なります。再作成するとコンテナ内だけの変更は失われます。ワークスペースは保持します。',{modal:true},'再作成');
          if (choice!=='再作成') throw Error('Image built; existing container was not replaced');
          await startContainer(s,folder.uri.fsPath,token,true);
        }
      } else { await synchronize(s,folder.uri.fsPath,token); if(profile) await build(s,profile,folder.uri.fsPath,token); }
    });
    output.appendLine('Completed: '+action);
  } finally { busy=false; }
}
async function page(data: Settings): Promise<string> {
  const template=await fs.readFile(path.resolve(__dirname,'../media/panel.html'),'utf8');
  return template.replace(/__NONCE__/g,randomBytes(18).toString('hex')).replace('__DATA__',()=>JSON.stringify(data).replace(/</g,'\\u003c'));
}
async function pick(folder: vscode.WorkspaceFolder): Promise<string|undefined> {
  const chosen=await vscode.window.showOpenDialog({defaultUri:folder.uri,canSelectFiles:true,canSelectFolders:false,canSelectMany:false});
  return chosen?.[0] ? safeRel(path.relative(folder.uri.fsPath,chosen[0].fsPath)) : undefined;
}
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.configure',async()=>{
    try {
      const folder=workspace(); const panel=vscode.window.createWebviewPanel('eclipseRemote','Eclipse Remote Build',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[],retainContextWhenHidden:true});
      panel.webview.html=await page(await load(folder));
      const subscription=panel.webview.onDidReceiveMessage(async(msg:{action:string;data:Settings;field?:string;profile?:string})=>{
        try {
          if (msg.action==='pick') { const value=await pick(folder); if(value) await panel.webview.postMessage({field:msg.field,value}); return; }
          if (!['save','sync','build','provision'].includes(msg.action)) return;
          await panel.webview.postMessage({busy:true}); await save(folder,msg.data);
          if(msg.action!=='save') await operation(msg.action as Action,folder,msg.profile);
          await panel.webview.postMessage({info:msg.action==='save'?'設定を保存しました':'完了しました'});
        } catch(e) { await panel.webview.postMessage({error:String(e)}); output.appendLine(String(e)); }
        finally { await panel.webview.postMessage({busy:false}); }
      });
      panel.onDidDispose(()=>subscription.dispose());
    } catch(e) { void vscode.window.showErrorMessage(String(e)); }
  }));
  for(const action of ['build','sync','provision'] as const) context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.'+action,async()=>{try{await operation(action);}catch(e){output.show(true);void vscode.window.showErrorMessage(String(e));}}));
}
export function deactivate(): void {}
