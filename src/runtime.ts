import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Settings, Profile, validate, validateProfile, relative as safeRel, localPath as absWorkspace, containerPath } from './model';
import { RunPlan } from './session';
export interface Cancellation { readonly isCancellationRequested: boolean; onCancellationRequested(fn: () => void): { dispose(): void } }
export interface Log { append(value: string): void; appendLine(value: string): void }
interface ContainerInfo { Id: string; Image: string; State: { Running: boolean; Status: string }; Mounts: { Source: string; Destination: string; Type: string; RW: boolean }[] }
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

/** SSH / rsync / Docker adapter. Importing this module performs no I/O. */
export function createRemote(output: Log) {
function sshArgs(s: Settings, root = process.cwd()) {
    const args = ['-p', String(s.ssh.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
    if (s.ssh.identityFile) {
        let key = s.ssh.identityFile;
        if (key.startsWith('~/'))
            key = path.join(os.homedir(), key.slice(2));
        else if (!path.isAbsolute(key))
            key = absWorkspace(root, key);
        args.push('-i', key);
    }
    return args;
}
function target(s: Settings) { return (s.ssh.user ? s.ssh.user + '@' : '') + s.ssh.host; }
function execute(cmd: string, args: string[], cwd: string, token?: Cancellation, capture = false): Promise<string> {
    if (token?.isCancellationRequested)
        return Promise.reject(new Error('操作をキャンセルしました'));
    return new Promise((resolve, reject) => {
        output.appendLine('$ ' + (cmd === 'ssh' ? 'ssh [remote command]' : [cmd, ...args].map(quote).join(' ')));
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let collected = '';
        let cancelled = false;
        const cancel = token?.onCancellationRequested(() => { cancelled = true; child.kill(); });
        if (token?.isCancellationRequested) { cancelled = true; child.kill(); }
        child.stdout.on('data', (b) => { if (capture)
            collected = (collected + b.toString()).slice(-1024 * 1024);
        else
            output.append(b.toString()); });
        child.stderr.on('data', (b) => output.append(b.toString()));
        child.once('error', e => { cancel?.dispose(); reject(e); });
        child.once('close', (code, signal) => { cancel?.dispose(); if (cancelled)
            reject(new Error('操作をキャンセルしました'));
        else if (code === 0)
            resolve(collected);
        else
            reject(Error(cmd + ' failed (exit ' + code + ', signal ' + signal + ')')); });
    });
}
async function ssh(s: Settings, root: string, command: string, token?: Cancellation, capture = false) { return execute('ssh', [...sshArgs(s, root), target(s), command], root, token, capture); }
async function transfer(s: Settings, root: string, paths: string[], remote: string, exclude: string[], token?: Cancellation) {
    const shell = ['ssh', ...sshArgs(s, root)].map(quote).join(' ');
    const host = s.ssh.host.includes(':') ? '[' + s.ssh.host + ']' : s.ssh.host;
    const destination = (s.ssh.user ? s.ssh.user + '@' : '') + host + ':' + remote + '/';
    const base = await fs.realpath(root);
    for (const rel of [...new Set(paths.map(safeRel))]) {
        const real = await fs.realpath(absWorkspace(root, rel));
        const inside = path.relative(base, real);
        if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
            throw Error('Source escapes workspace through symlink: ' + rel);
        await execute('rsync', ['-az', '--checksum', '--safe-links', '--protect-args', '--relative', '--itemize-changes', '-e', shell, ...exclude.flatMap(x => ['--exclude', x]), '--', './' + rel, destination], root, token);
    }
}
async function build(s: Settings, profile: Profile, root: string, token?: Cancellation) {
    const p = profile;
    validateProfile(p);
    const expand = (v: string) => v.replace(/\$\{workspaceFolder\}/g, '/workspace');
    const args = [s.remote.dockerCommand, 'exec', '-w', '/workspace', ...Object.entries(p.environment).flatMap(([k, v]) => ['-e', k + '=' + expand(v)]), s.remote.container, p.eclipseExecutable, '-nosplash', '-application', 'org.eclipse.cdt.managedbuilder.core.headlessbuild', '-data', p.eclipseWorkspace, ...p.imports.flatMap(x => ['-importAll', containerPath(x)]), '-build', p.project + '/' + p.configuration, ...p.extraArgs.map(expand)];
    output.appendLine('Eclipse: ' + p.project + ' / ' + p.configuration);
    await ssh(s, root, args.map(quote).join(' '), token);
}
async function provision(s: Settings, root: string, token?: Cancellation) {
    validate(s);
    const bundled = path.resolve(__dirname, '../docker');
    const base = await fs.readFile(s.provision.dockerfile ? absWorkspace(root, s.provision.dockerfile) : path.join(bundled, 'Dockerfile'), 'utf8');
    const tag = createHash('sha256').update(JSON.stringify([root, s.provision, base])).digest('hex').slice(0, 16);
    const remote = path.posix.normalize(s.remote.root).replace(/\/$/, '') + '.erb-context/' + tag;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclipse-image-'));
    try {
        const manifest = s.provision.archives.map((a, i) => ({ ...a, source: String(i) + '/' + path.posix.basename(safeRel(a.source)) }));
        const copy = s.provision.archives.map((a, i) => 'COPY ' + JSON.stringify([safeRel(a.source), '/tmp/.erb-archives/' + manifest[i].source])).join('\n');
        const dockerfile = base + '\nUSER root\nCOPY [".erb-install.py", "/tmp/.erb-install.py"]\nCOPY [".erb-archives.json", "/tmp/.erb-archives.json"]\n' + copy + '\nRUN python3 /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives && rm -rf /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives\nWORKDIR /workspace\nCMD ["sleep", "infinity"]\n';
        await fs.writeFile(path.join(temp, '.erb-Dockerfile'), dockerfile);
        await fs.writeFile(path.join(temp, '.erb-archives.json'), JSON.stringify(manifest));
        await fs.copyFile(path.join(bundled, 'install-archives.py'), path.join(temp, '.erb-install.py'));
        await ssh(s, root, 'mkdir -p -- ' + quote(remote), token);
        const upload = structuredClone(s);
        if (upload.ssh.identityFile && !path.isAbsolute(upload.ssh.identityFile) && !upload.ssh.identityFile.startsWith('~/'))
            upload.ssh.identityFile = absWorkspace(root, upload.ssh.identityFile);
        await transfer(upload, temp, ['.'], remote, [], token);
        await transfer(s, root, s.provision.archives.map(a => a.source), remote, [], token);
        await ssh(s, root, [s.remote.dockerCommand, 'build', '-f', remote + '/.erb-Dockerfile', '--build-arg', 'BASE_IMAGE=' + s.provision.baseImage, '-t', s.provision.image, remote].map(quote).join(' '), token);
    }
    finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
}
async function inspectContainer(s: Settings, root: string, token?: Cancellation): Promise<ContainerInfo> {
    const result = await ssh(s, root, [s.remote.dockerCommand, 'container', 'inspect', s.remote.container].map(quote).join(' '), token, true);
    const [container] = JSON.parse(result);
    if (!container?.Id || !container.State || !Array.isArray(container.Mounts))
        throw Error('Docker returned an invalid container description');
    return container;
}
function workspaceMounted(s: Settings, c: ContainerInfo) {
    return c.Mounts.some(m => m.Destination === '/workspace' && m.Type === 'bind' && m.RW && m.Source === path.posix.normalize(s.remote.root).replace(/\/$/, ''));
}
async function verifyDeployment(s: Settings, root: string, token?: Cancellation) {
    const c = await inspectContainer(s, root, token);
    if (!c.State.Running)
        throw Error('Dockerコンテナが起動していません: ' + c.State.Status);
    if (!workspaceMounted(s, c))
        throw Error('Dockerの /workspace マウントが設定と一致しないか、書き込み不可です');
    await ssh(s, root, [s.remote.dockerCommand, 'exec', s.remote.container, '/bin/sh', '-c', 'test -d /workspace && test -w /workspace'].map(quote).join(' '), token);
    return 'Dockerデプロイ完了: ' + s.remote.container + ' / 起動中 / ' + c.Id.slice(0, 12);
}
async function startContainer(s: Settings, root: string, token?: Cancellation, replace = false) {
    const docker = (args: string[], capture = false) => ssh(s, root, [s.remote.dockerCommand, ...args].map(quote).join(' '), token, capture);
    const names = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'], true)).trim().split(/\r?\n/);
    if (names.includes(s.remote.container)) {
        const c = await inspectContainer(s, root, token);
        const image = (await docker(['image', 'inspect', '--format', '{{.Id}}', s.provision.image], true)).trim();
        if (c.Image === image && workspaceMounted(s, c)) {
            if (!c.State.Running)
                await docker(['start', s.remote.container]);
            return true;
        }
        if (!replace)
            return false;
        await docker(['rm', '-f', s.remote.container]);
    }
    await ssh(s, root, 'mkdir -p -- ' + quote(s.remote.root), token);
    const source = path.posix.normalize(s.remote.root).replace(/\/$/, '');
    const mount = 'type=bind,"source=' + source.replace(/"/g, '""') + '",target=/workspace';
    await docker(['run', '-d', '--name', s.remote.container, '--label', 'eclipse-remote-build=managed', '--mount', mount, '-w', '/workspace', s.provision.image]);
    return true;
}

async function synchronize(plan: RunPlan, root: string, token?: Cancellation): Promise<void> {
    const s = plan.settings, remote = path.posix.normalize(s.remote.root).replace(/\/$/, '');
    await ssh(s, root, 'mkdir -p -- ' + quote(remote), token);
    // Never transmit live copies of files whose bytes were fixed for this run.
    const escaped = (x: string) => x.replace(/[\\*?\[\]]/g, c => '\\' + c);
    const exclusions = [...s.sync.exclude, ...plan.pinnedPaths.map(p => '/' + escaped(p))];
    const includes = s.sync.include.filter(p => !plan.pinnedPaths.some(f => safeRel(p) === f || safeRel(p).startsWith(f + '/')));
    await transfer(s, root, includes, remote, exclusions, token);
    if (plan.pinnedPaths.length) {
        const upload = structuredClone(s);
        if (upload.ssh.identityFile && !path.isAbsolute(upload.ssh.identityFile) && !upload.ssh.identityFile.startsWith('~/')) upload.ssh.identityFile = absWorkspace(root, upload.ssh.identityFile);
        await transfer(upload, plan.staging, plan.pinnedPaths, remote, [], token);
    }
}
return { synchronize, build, provision, startContainer, verifyDeployment };
}
