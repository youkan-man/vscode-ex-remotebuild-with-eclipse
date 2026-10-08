import * as path from 'node:path';
import { isIP } from 'node:net';

export type Archive = { source: string; destination: string; stripComponents?: number };
export type Profile = { name: string; profileFile?: string; project: string; configuration: string; eclipseWorkspace: string; eclipseExecutable: string; imports: string[]; extraArgs: string[]; environment: Record<string, string> };
export type Settings = {
  ssh: { host: string; port: number; user: string; identityFile: string };
  remote: { root: string; container: string; dockerCommand: string };
  sync: { include: string[]; exclude: string[]; profileFiles: string[] };
  provision: { baseImage: string; image: string; dockerfile: string; archives: Archive[] };
  profiles: Profile[];
};
export type Action = 'sync' | 'build' | 'deploy';
export type Reader = (relativePath: string) => Promise<Buffer>;
export type Snapshot = { action: Action; settings: Settings; profile?: Profile; files: Record<string, string> };
export type Preview = { profile?: Profile; origin: string; error?: string };
export const defaultProfile: Profile = { name: 'Debug', profileFile: '', project: 'MyProject', configuration: 'Debug', eclipseWorkspace: '/tmp/eclipse-workspace', eclipseExecutable: '/opt/eclipse/eclipse', imports: ['.'], extraArgs: [], environment: {} };
export const defaults: Settings = {
  ssh: { host: '', port: 22, user: '', identityFile: '' },
  remote: { root: '/srv/eclipse-remote-build', container: 'eclipse-builder', dockerCommand: 'docker' },
  sync: { include: ['.'], exclude: ['.git/', '.local_relay/', '.vscode-test/', 'node_modules/', 'dist/', '*.o', '*.a'], profileFiles: [] },
  provision: { baseImage: 'ubuntu:24.04', image: 'eclipse-builder:local', dockerfile: '', archives: [] }, profiles: [defaultProfile]
};
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function plain(v: unknown): v is string { return typeof v === 'string' && !/[\x00-\x1f]/.test(v); }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(plain); }
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function relative(value: string): string {
  need(plain(value) && value.length && !/^(?:[A-Za-z]:|[\\/])/.test(value), 'ワークスペース相対パスが必要です: ' + value);
  const result = path.posix.normalize(value.replace(/\\/g, '/'));
  need(result !== '..' && !result.startsWith('../'), 'ワークスペース外のパスです: ' + value);
  return result;
}
export function localPath(root: string, value: string): string { return path.resolve(root, relative(value)); }
export function containerPath(value: string): string { const p = relative(value); return p === '.' ? '/workspace' : '/workspace/' + p; }
function absolute(v: unknown): v is string { return plain(v) && v.startsWith('/') && !v.split('/').includes('..'); }
// Loading and saving drafts checks their shape, never unrelated execution requirements.
export function normalize(value: unknown): Settings {
  need(object(value), '設定はJSONオブジェクトにしてください');
  const result = { ...structuredClone(defaults), ...value } as Settings;
  for (const key of ['ssh', 'remote', 'sync', 'provision'] as const) {
    need(value[key] === undefined || object(value[key]), '設定の形式が不正です: ' + key);
    (result as any)[key] = { ...defaults[key], ...(value[key] as object || {}) };
  }
  need(Array.isArray(result.profiles) && result.profiles.every(object), 'profiles は配列にしてください');
  result.profiles = result.profiles.map(p => ({ ...structuredClone(defaultProfile), ...p }));
  need(Array.isArray(result.provision.archives) && result.provision.archives.every(object), 'archives は配列にしてください');
  for (const key of ['include', 'exclude', 'profileFiles'] as const) need(strings(result.sync[key]), '転送対象は文字列の配列にしてください: ' + key);
  need([result.ssh.host, result.ssh.user, result.ssh.identityFile, result.remote.root, result.remote.container, result.remote.dockerCommand, result.provision.baseImage, result.provision.image, result.provision.dockerfile].every(v => typeof v === 'string'), '設定の文字列フィールドが不正です');
  return structuredClone(result);
}
export function validateConnection(s: Settings, docker: boolean): void {
  need(isIP(s.ssh.host) || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s.ssh.host), 'SSHホストを指定してください');
  need(!s.ssh.user || /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s.ssh.user), 'SSHユーザー名が不正です');
  need(Number.isInteger(s.ssh.port) && s.ssh.port > 0 && s.ssh.port <= 65535, 'SSHポートは1～65535です');
  need(plain(s.ssh.identityFile), '秘密鍵のパスが不正です');
  need(absolute(s.remote.root) && path.posix.normalize(s.remote.root) !== '/', '転送先はルート以外の絶対パスにしてください');
  if (docker) {
    need(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s.remote.container), 'コンテナ名が不正です');
    need(/^(?:\/[A-Za-z0-9_./-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(s.remote.dockerCommand), 'Dockerコマンドが不正です');
  }
}
export function validateProfile(p: Profile): void {
  need([p.name, p.project, p.configuration].every(v => plain(v) && v.length), 'プロファイル名・プロジェクト・構成を指定してください');
  need(absolute(p.eclipseWorkspace) && absolute(p.eclipseExecutable), 'Eclipseのパスはコンテナ内の絶対パスにしてください');
  need(strings(p.imports) && strings(p.extraArgs), 'インポート元・追加引数の形式が不正です');
  p.imports.forEach(relative);
  need(object(p.environment), '環境変数はJSONオブジェクトにしてください');
  need(Object.entries(p.environment).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0')), '環境変数の名前または値が不正です');
}
function validateDeployment(s: Settings): void {
  need([s.provision.image, s.provision.baseImage].every(v => plain(v) && v && !/\s/.test(v) && !v.startsWith('-')), 'Dockerイメージ名を指定してください');
  if (s.provision.dockerfile) relative(s.provision.dockerfile);
  for (const a of s.provision.archives) {
    const source = relative(a.source);
    need(!source.startsWith('.erb-') && /\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|txz|tbz2|zip)$/i.test(source), 'TARまたはZIPを指定してください: ' + source);
    need(absolute(a.destination) && path.posix.normalize(a.destination) !== '/', 'アーカイブの展開先を指定してください');
    need(a.stripComponents === undefined || (Number.isInteger(a.stripComponents) && a.stripComponents >= 0), '除去する階層数は0以上の整数です');
  }
}
export function mergeProfile(p: Profile, bytes?: Buffer): Profile {
  if (!bytes) return structuredClone(p);
  const overrides: unknown = JSON.parse(bytes.toString('utf8'));
  need(object(overrides), '構成JSONはオブジェクトにしてください');
  return { ...structuredClone(p), ...overrides, name: p.name, profileFile: p.profileFile } as Profile;
}
export async function preview(p: Profile, read: Reader): Promise<Preview> {
  try { return { profile: mergeProfile(p, p.profileFile ? await read(relative(p.profileFile)) : undefined), origin: p.profileFile || '画面設定' }; }
  catch (e) { return { origin: p.profileFile || '画面設定', error: String((e as Error).message) }; }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// The profile JSON bytes and effective values belong to one run, not to the live editor.
export async function prepare(action: Action, draft: Settings, selected: number, read: Reader): Promise<Snapshot> {
  const settings = normalize(draft), files: Record<string, string> = {};
  validateConnection(settings, action !== 'sync');
  if (action === 'deploy') { validateDeployment(settings); return freeze({ action, settings, files }); }
  settings.sync.include.forEach(relative); settings.sync.profileFiles.forEach(relative);
  const profile = settings.profiles[selected];
  const paths = [...settings.sync.profileFiles, ...(profile?.profileFile ? [profile.profileFile] : [])];
  for (const p of new Set(paths.map(relative))) files[p] = (await read(p)).toString('base64');
  let effective: Profile | undefined;
  if (action === 'build') {
    need(profile, 'ビルドプロファイルを選択してください');
    effective = mergeProfile(profile, profile.profileFile ? Buffer.from(files[relative(profile.profileFile)], 'base64') : undefined);
    validateProfile(effective);
  }
  return freeze({ action, settings, profile: effective, files });
}
