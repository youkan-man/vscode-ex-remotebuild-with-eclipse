import * as path from 'node:path';
import { isIP } from 'node:net';

export type Archive = { source: string; destination: string; stripComponents?: number };
export type Profile = {
  name: string; profileFile?: string; project: string; configuration: string;
  eclipseWorkspace: string; eclipseExecutable: string; imports: string[];
  extraArgs: string[]; environment: Record<string, string>;
};
export type Settings = {
  ssh: { host: string; port: number; user: string; identityFile: string };
  remote: { root: string; container: string; dockerCommand: string };
  sync: { include: string[]; exclude: string[]; profileFiles: string[] };
  provision: { baseImage: string; image: string; dockerfile: string; archives: Archive[] };
  profiles: Profile[];
};
export const newProfile = (name = 'Debug'): Profile => ({ name, profileFile: '', project: 'MyProject', configuration: name,
  eclipseWorkspace: '/tmp/eclipse-workspace', eclipseExecutable: '/opt/eclipse/eclipse', imports: ['.'], extraArgs: [], environment: {} });
export const defaults: Settings = {
  ssh: { host: '', port: 22, user: '', identityFile: '' },
  remote: { root: '/srv/eclipse-remote-build', container: 'eclipse-builder', dockerCommand: 'docker' },
  sync: { include: ['.'], exclude: ['.git/', '.local_relay/', '.vscode-test/', 'node_modules/', 'dist/', '*.o', '*.a'], profileFiles: [] },
  provision: { baseImage: 'ubuntu:24.04', image: 'eclipse-builder:local', dockerfile: '', archives: [] }, profiles: [newProfile()]
};
const text = (v: unknown): v is string => typeof v === 'string' && !/[\x00-\x1f]/.test(v);
export function relative(value: string): string {
  if (!text(value) || !value || /^[A-Za-z]:/.test(value) || value.replace(/\\/g, '/').startsWith('/')) throw Error('ワークスペース内の相対パスを指定してください: ' + value);
  const p = path.posix.normalize(value.replace(/\\/g, '/'));
  if (p === '..' || p.startsWith('../')) throw Error('ワークスペース外のパスです: ' + value);
  return p;
}
export const localPath = (root: string, rel: string): string => path.resolve(root, relative(rel));
export const containerPath = (rel: string): string => relative(rel) === '.' ? '/workspace/' : '/workspace/' + relative(rel);
export const remotePath = (v: string): boolean => text(v) && v.startsWith('/') && !v.split('/').includes('..');
export function validateProfile(p: Profile): void {
  for (const key of ['name', 'project', 'configuration'] as const) if (!text(p[key]) || !p[key]) throw Error('プロファイルの ' + key + ' を指定してください');
  if (!Array.isArray(p.imports) || !Array.isArray(p.extraArgs) || !p.extraArgs.every(text)) throw Error('インポート元と追加引数は文字列の配列が必要です');
  p.imports.forEach(relative);
  if (p.profileFile) relative(p.profileFile);
  if (!remotePath(p.eclipseWorkspace) || !remotePath(p.eclipseExecutable)) throw Error('Eclipseのパスはコンテナ内の絶対パスで指定してください');
  if (!p.environment || typeof p.environment !== 'object' || Array.isArray(p.environment)) throw Error('環境変数はJSONオブジェクトが必要です');
  for (const [key, value] of Object.entries(p.environment)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw Error('環境変数の名前と文字列値を確認してください: ' + key);
}
export function validate(s: Settings, execution = true): void {
  if (!s?.ssh || !s.remote || !s.sync || !s.provision || !Array.isArray(s.profiles)) throw Error('設定形式が不正です');
  if ((execution || s.ssh.host) && !(isIP(s.ssh.host) || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s.ssh.host))) throw Error('SSHホストを指定してください');
  if (s.ssh.user && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s.ssh.user)) throw Error('SSHユーザー名が不正です');
  if (!Number.isInteger(s.ssh.port) || s.ssh.port < 1 || s.ssh.port > 65535) throw Error('SSHポートは1〜65535です');
  if (!text(s.ssh.identityFile)) throw Error('秘密鍵のパスが不正です');
  if (!remotePath(s.remote.root) || path.posix.normalize(s.remote.root) === '/') throw Error('転送先は / 以外の絶対パスが必要です');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s.remote.container)) throw Error('コンテナ名が不正です');
  if (!/^(?:\/[A-Za-z0-9_./-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(s.remote.dockerCommand)) throw Error('Dockerコマンドが不正です');
  for (const key of ['include', 'exclude', 'profileFiles'] as const) if (!Array.isArray(s.sync[key]) || !s.sync[key].every(text)) throw Error('転送設定を確認してください: ' + key);
  s.sync.include.forEach(relative); s.sync.profileFiles.forEach(relative);
  if (!text(s.provision.image) || !s.provision.image || !text(s.provision.baseImage) || !s.provision.baseImage || /\s/.test(s.provision.image + s.provision.baseImage)) throw Error('イメージ名が不正です');
  if (s.provision.dockerfile) relative(s.provision.dockerfile);
  if (!Array.isArray(s.provision.archives)) throw Error('アーカイブ一覧が不正です');
  for (const a of s.provision.archives) {
    const p = relative(a.source);
    if (p.startsWith('.erb-') || !/\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|txz|tbz2|zip)$/i.test(p)) throw Error('TAR / ZIPを指定してください: ' + p);
    if (!remotePath(a.destination) || path.posix.normalize(a.destination) === '/') throw Error('展開先は / 以外の絶対パスが必要です');
    if (a.stripComponents !== undefined && (!Number.isInteger(a.stripComponents) || a.stripComponents < 0)) throw Error('除去階層数は0以上の整数です');
  }
  // External JSON may supply fields not present in the inline configuration.
  for (const p of s.profiles) { if (!p.name || !text(p.name)) throw Error('プロファイル名を指定してください'); if (p.profileFile) relative(p.profileFile); else validateProfile(p); }
  if (new Set(s.profiles.map(p => p.name)).size !== s.profiles.length) throw Error('プロファイル名が重複しています');
}
export function resolveProfile(base: Profile, bytes?: Buffer): { profile: Profile; overrides: string[] } {
  let overlay: Partial<Profile> = {};
  if (bytes) { overlay = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); if (!overlay || Array.isArray(overlay) || typeof overlay !== 'object') throw Error('構成JSONはオブジェクトが必要です'); }
  const profile = { ...structuredClone(base), ...overlay, name: base.name, profileFile: base.profileFile };
  validateProfile(profile);
  return { profile, overrides: Object.keys(overlay).filter(k => k !== 'name' && k !== 'profileFile') };
}
