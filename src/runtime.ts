import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Settings, Snapshot, containerPath, localPath, relative } from './configuration';

export class RemoteRuntime {
  constructor(private readonly output: vscode.OutputChannel) {}
  private quote(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }
  private args(s: Settings, root: string): string[] {
    const a = ['-p', String(s.ssh.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
    if (s.ssh.identityFile) {
      const k = s.ssh.identityFile;
      a.push('-i', k.startsWith('~/') ? path.join(os.homedir(), k.slice(2)) : path.isAbsolute(k) ? k : localPath(root, k));
    }
    return a;
  }
  private execute(cmd: string, args: string[], root: string, token: vscode.CancellationToken, capture = false): Promise<string> {
    if (token.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    this.output.appendLine(cmd === 'ssh' ? '$ ssh [remote command]' : '$ rsync --checksum [workspace files]');
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let result = '', cancelled = false;
      const subscription = token.onCancellationRequested(() => { cancelled = true; child.kill(); });
      child.stdout.on('data', (b: Buffer) => { if (capture) result = (result + b.toString()).slice(-1024 * 1024); else this.output.append(b.toString()); });
      child.stderr.on('data', (b: Buffer) => this.output.append(b.toString()));
      child.once('error', e => { subscription.dispose(); reject(e); });
      child.once('close', (code, signal) => { subscription.dispose(); if (cancelled) reject(new vscode.CancellationError()); else if (code === 0) resolve(result); else reject(new Error(`${cmd} failed (exit ${code}, signal ${signal})`)); });
    });
  }
  private ssh(s: Settings, root: string, command: string[], token: vscode.CancellationToken, capture = false): Promise<string> {
    return this.execute('ssh', [...this.args(s, root), (s.ssh.user ? s.ssh.user + '@' : '') + s.ssh.host, command.map(v => this.quote(v)).join(' ')], root, token, capture);
  }
  private async transfer(s: Settings, root: string, paths: string[], remote: string, exclude: string[], token: vscode.CancellationToken, keyRoot = root): Promise<void> {
    const shell = ['ssh', ...this.args(s, keyRoot)].map(v => this.quote(v)).join(' ');
    const host = s.ssh.host.includes(':') ? '[' + s.ssh.host + ']' : s.ssh.host;
    const target = (s.ssh.user ? s.ssh.user + '@' : '') + host + ':' + remote + '/';
    const base = await fs.realpath(root);
    for (const rel of new Set(paths.map(relative))) {
      const real = await fs.realpath(localPath(root, rel)), inside = path.relative(base, real);
      if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('Source escapes workspace through symlink: ' + rel);
      await this.execute('rsync', ['-az', '--checksum', '--safe-links', '--protect-args', '--relative', '--itemize-changes', '-e', shell, ...exclude.flatMap(v => ['--exclude', v]), '--', './' + rel, target], root, token);
    }
  }
  async synchronize(plan: Snapshot, root: string, token: vscode.CancellationToken): Promise<void> {
    const s = plan.settings, remote = path.posix.normalize(s.remote.root).replace(/\/$/, '');
    await this.ssh(s, root, ['mkdir', '-p', '--', remote], token);
    await this.transfer(s, root, s.sync.include, remote, s.sync.exclude, token);
    if (!Object.keys(plan.files).length) return;
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'erb-profile-'));
    try {
      for (const [rel, encoded] of Object.entries(plan.files)) {
        const dest = localPath(stage, rel); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, Buffer.from(encoded, 'base64'));
      }
      await this.transfer(s, stage, Object.keys(plan.files), remote, [], token, root);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async build(plan: Snapshot, root: string, token: vscode.CancellationToken): Promise<void> {
    const s = plan.settings, p = plan.profile;
    if (!p) throw new Error('Missing resolved build profile');
    const expand = (v: string) => v.replace(/\$\{workspaceFolder\}/g, '/workspace');
    this.output.appendLine(`Eclipse: ${p.project} / ${p.configuration}`);
    await this.ssh(s, root, [s.remote.dockerCommand, 'exec', '-w', '/workspace', ...Object.entries(p.environment).flatMap(([k, v]) => ['-e', k + '=' + expand(v)]), s.remote.container, p.eclipseExecutable, '-nosplash', '-application', 'org.eclipse.cdt.managedbuilder.core.headlessbuild', '-data', p.eclipseWorkspace, ...p.imports.flatMap(v => ['-importAll', containerPath(v)]), '-build', p.project + '/' + p.configuration, ...p.extraArgs.map(expand)], token);
  }
  async deploy(plan: Snapshot, root: string, token: vscode.CancellationToken, report: (v: string) => void, confirm: () => Promise<boolean>): Promise<string> {
    const s = plan.settings, bundled = path.resolve(__dirname, '../docker');
    const base = await fs.readFile(s.provision.dockerfile ? localPath(root, s.provision.dockerfile) : path.join(bundled, 'Dockerfile'), 'utf8');
    const tag = createHash('sha256').update(JSON.stringify([root, s.provision, base])).digest('hex').slice(0, 16);
    const remote = path.posix.normalize(s.remote.root).replace(/\/$/, '') + '.erb-context/' + tag;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'erb-image-'));
    const docker = (args: string[], capture = false) => this.ssh(s, root, [s.remote.dockerCommand, ...args], token, capture);
    try {
      report('1/3 アーカイブ転送・イメージ構築');
      const manifest = s.provision.archives.map((a, i) => ({ ...a, source: i + '/' + path.posix.basename(relative(a.source)) }));
      const copies = s.provision.archives.map((a, i) => 'COPY ' + JSON.stringify([relative(a.source), '/tmp/.erb-archives/' + manifest[i].source])).join('\n');
      const recipe = base + '\nUSER root\nCOPY [".erb-install.py", "/tmp/.erb-install.py"]\nCOPY [".erb-archives.json", "/tmp/.erb-archives.json"]\n' + copies + '\nRUN python3 /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives && rm -rf /tmp/.erb-install.py /tmp/.erb-archives.json /tmp/.erb-archives\nWORKDIR /workspace\nCMD ["sleep", "infinity"]\n';
      await fs.writeFile(path.join(temp, '.erb-Dockerfile'), recipe);
      await fs.writeFile(path.join(temp, '.erb-archives.json'), JSON.stringify(manifest));
      await fs.copyFile(path.join(bundled, 'install-archives.py'), path.join(temp, '.erb-install.py'));
      await this.ssh(s, root, ['mkdir', '-p', '--', remote], token);
      await this.transfer(s, temp, ['.'], remote, [], token, root);
      await this.transfer(s, root, s.provision.archives.map(a => a.source), remote, [], token);
      await docker(['build', '-f', remote + '/.erb-Dockerfile', '--build-arg', 'BASE_IMAGE=' + s.provision.baseImage, '-t', s.provision.image, remote]);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
    report('2/3 コンテナ作成・起動');
    const source = path.posix.normalize(s.remote.root).replace(/\/$/, '');
    const mounted = (c: any) => c.Mounts?.some((m: any) => m.Destination === '/workspace' && m.Source === source && m.Type === 'bind' && m.RW);
    let exists = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'], true)).trim().split(/\r?\n/).includes(s.remote.container);
    if (exists) {
      const [c] = JSON.parse(await docker(['inspect', s.remote.container], true));
      const image = (await docker(['image', 'inspect', '--format', '{{.Id}}', s.provision.image], true)).trim();
      if (c.Image === image && mounted(c)) { if (!c.State.Running) await docker(['start', s.remote.container]); }
      else {
        if (!await confirm()) throw new Error('デプロイを中止しました。既存コンテナは変更していません');
        await docker(['rm', '-f', s.remote.container]); exists = false;
      }
    }
    if (!exists) {
      await this.ssh(s, root, ['mkdir', '-p', '--', source], token);
      await docker(['run', '-d', '--name', s.remote.container, '--label', 'eclipse-remote-build=managed', '--mount', 'type=bind,"source=' + source.replace(/"/g, '""') + '",target=/workspace', '-w', '/workspace', s.provision.image]);
    }
    report('3/3 起動・マウント確認');
    const [c] = JSON.parse(await docker(['inspect', s.remote.container], true));
    if (!c.State?.Running || !mounted(c)) throw new Error('コンテナの起動状態またはマウントが設定と一致しません');
    await docker(['exec', s.remote.container, '/bin/sh', '-c', 'test -d /workspace && test -w /workspace']);
    return 'Dockerデプロイ完了: ' + s.remote.container;
  }
}
