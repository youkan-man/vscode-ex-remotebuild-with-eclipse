import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { Settings, Profile, defaults, localPath, relative, resolveProfile, validate } from './model';

export type Draft = { data: Settings; selected: number; environments: string[] };
export type Effective = { name: string; profile?: Profile; overrides: string[]; digest?: string; error?: string };
export type RunPlan = { settings: Settings; profile?: Profile; staging: string; pinnedPaths: string[]; digest?: string; dispose(): Promise<void> };
export type ReadFile = (absolute: string) => Promise<Buffer>;
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function makeDraft(data: Settings, selected = 0): Draft { return { data: structuredClone(data), selected: Math.max(0, Math.min(selected, data.profiles.length - 1)), environments: data.profiles.map(p => JSON.stringify(p.environment, null, 2)) }; }

/** Owns the editable workspace state. UI routes never load a second copy to execute. */
export class WorkspaceSession {
  private draft: Draft = makeDraft(defaults);
  private saved = JSON.stringify(defaults);
  private diskHash: string | undefined;
  private listeners = new Set<() => void>();
  revision = 0;
  constructor(readonly root: string, readonly config: string, private readonly read: ReadFile = fs.readFile) {}
  get value(): Draft { return structuredClone(this.draft); }
  get dirty(): boolean { try { return JSON.stringify(this.settings()) !== this.saved; } catch { return true; } }
  onChange(fn: () => void): { dispose(): void } { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }
  private changed(): void { this.revision++; for (const fn of this.listeners) fn(); }
  edit(next: Draft): void {
    if (!next?.data || !Array.isArray(next.data.profiles) || !Array.isArray(next.environments) || !Number.isInteger(next.selected)) throw Error('編集データが不正です');
    if (!same(this.draft, next)) { this.draft = structuredClone(next); this.changed(); }
  }
  select(index: number): void { const d = this.value; d.selected = index; this.edit(d); }
  settings(): Settings {
    const data = structuredClone(this.draft.data);
    data.profiles.forEach((p, i) => {
      try { p.environment = JSON.parse(this.draft.environments[i] ?? '{}'); }
      catch { throw Error(p.name + ': 環境変数のJSONが不正です'); }
    });
    return data;
  }
  async reload(): Promise<void> {
    let bytes: Buffer | undefined;
    try { bytes = await fs.readFile(this.config); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const data: Settings = bytes ? JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) : structuredClone(defaults);
    validate(data, false); this.diskHash = bytes ? hash(bytes) : undefined;
    this.saved = JSON.stringify(data); this.draft = makeDraft(data, this.draft.selected); this.changed();
  }
  async save(): Promise<void> {
    const data = this.settings(); validate(data, false);
    let current: Buffer | undefined;
    try { current = await fs.readFile(this.config); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if ((current ? hash(current) : undefined) !== this.diskHash) throw Error('設定ファイルが外部で変更されています。「ファイルを再読込」で確認してください');
    const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    await fs.mkdir(path.dirname(this.config), { recursive: true });
    const temp = this.config + '.' + randomBytes(6).toString('hex') + '.tmp';
    try { await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, this.config); }
    finally { await fs.rm(temp, { force: true }); }
    this.diskHash = hash(bytes); this.saved = JSON.stringify(data); this.changed();
  }
  async contained(rel: string): Promise<string> {
    const absolute = localPath(this.root, rel), real = await fs.realpath(absolute), base = await fs.realpath(this.root);
    const r = path.relative(base, real);
    if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) throw Error('ワークスペース外を参照しています: ' + rel);
    return absolute;
  }
  async preview(): Promise<Effective[]> {
    const d = this.value;
    return Promise.all(d.data.profiles.map(async (base, index) => {
      try {
        const inline = { ...base, environment: JSON.parse(d.environments[index] ?? '{}') };
        const bytes = base.profileFile ? await this.read(await this.contained(base.profileFile)) : undefined;
        return { name: base.name, ...resolveProfile(inline, bytes), digest: bytes ? hash(bytes) : undefined };
      } catch (e) { return { name: base.name, overrides: [], error: String((e as Error).message) }; }
    }));
  }
  /** Captures bytes and effective values together. No profile read occurs after this boundary. */
  async prepare(build: boolean): Promise<RunPlan> {
    const settings = this.settings(); validate(settings);
    const selected = this.draft.selected;
    if (build && !settings.profiles[selected]) throw Error('ビルドするプロファイルを選択してください');
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'erb-profile-'));
    const pinnedPaths = [...new Set([...settings.sync.profileFiles, ...settings.profiles.flatMap(p => p.profileFile ? [p.profileFile] : [])].map(relative))];
    const captured = new Map<string, Buffer>();
    const ancestors = new Set<string>();
    const walk = async (rel: string): Promise<void> => {
      const abs = await this.contained(rel), stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        const real = await fs.realpath(abs); if (ancestors.has(real)) throw Error('プロファイルの循環参照です: ' + rel);
        ancestors.add(real);
        try { await fs.mkdir(localPath(staging, rel), { recursive: true }); for (const entry of await fs.readdir(abs)) await walk(relative(path.posix.join(rel, entry))); }
        finally { ancestors.delete(real); }
      }
      else if (stat.isFile()) {
        if (captured.has(relative(rel))) return;
        const bytes = await this.read(abs); captured.set(relative(rel), bytes);
        const dest = localPath(staging, rel); await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes, { mode: stat.mode & 0o777 }); await fs.utimes(dest, stat.atime, stat.mtime);
      } else throw Error('通常のプロファイルファイルを指定してください: ' + rel);
    };
    try {
      // Reject recursive source roots in profile inputs; these are build configuration files.
      if (pinnedPaths.includes('.')) throw Error('追加プロファイルにはファイルまたは専用ディレクトリを指定してください');
      for (const rel of pinnedPaths) await walk(rel);
      const base = settings.profiles[selected];
      const bytes = base?.profileFile ? captured.get(relative(base.profileFile)) : undefined;
      if (build && base?.profileFile && !bytes) throw Error('構成JSONには通常のファイルを指定してください: ' + base.profileFile);
      const profile = build && base ? resolveProfile(base, bytes).profile : undefined;
      const digest = bytes ? hash(bytes) : undefined;
      return { settings, profile, staging, pinnedPaths, digest, dispose: () => fs.rm(staging, { recursive: true, force: true }) };
    } catch (e) { await fs.rm(staging, { recursive: true, force: true }); throw e; }
  }
}
