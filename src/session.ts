import { normalize, Settings } from './configuration';

// One workspace owns one draft. Every UI entry point snapshots this same owner.
export class ConfigurationSession {
  private current: Settings;
  private persisted: string;
  private selection = 0;
  revision = 0;
  errors: Record<string, string> = {};
  rawEnvironment: Record<string, string> = {};
  status = '待機';
  busy = false;
  conflict = false;
  constructor(value: Settings, private readonly notify: () => void) {
    this.current = normalize(value); this.persisted = JSON.stringify(this.current);
  }
  get data(): Settings { return structuredClone(this.current); }
  get selected(): number { return this.selection; }
  get dirty(): boolean { return JSON.stringify(this.current) !== this.persisted || Object.keys(this.errors).length > 0; }
  update(value: Settings, errors: Record<string, string> = {}, raw: Record<string, string> = {}, selected = this.selection): void {
    this.current = normalize(value); this.errors = { ...errors }; this.rawEnvironment = { ...raw };
    this.selection = Number.isInteger(selected) ? Math.max(0, Math.min(selected, this.current.profiles.length - 1)) : this.selection;
    this.revision++; this.notify();
  }
  select(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.current.profiles.length) return;
    this.selection = index; this.revision++; this.notify();
  }
  markSaved(snapshot: Settings): void { this.persisted = JSON.stringify(snapshot); this.conflict = false; this.notify(); }
  external(value: Settings): boolean {
    const next = normalize(value);
    if (JSON.stringify(next) === this.persisted) return false;
    if (this.dirty) { this.conflict = true; this.notify(); return false; }
    this.reload(next); return true;
  }
  reload(value: Settings): void {
    this.current = normalize(value); this.persisted = JSON.stringify(this.current);
    this.errors = {}; this.rawEnvironment = {}; this.conflict = false;
    this.selection = Math.min(this.selection, Math.max(0, this.current.profiles.length - 1)); this.revision++; this.notify();
  }
  signal(status: string, busy = this.busy): void { this.status = status; this.busy = busy; this.notify(); }
}
