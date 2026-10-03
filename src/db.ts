import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Netlist, SolveOptions, SolveResult } from './types';

export interface CaseRow {
  id: number;
  name: string;
  netlist: Netlist;
  options: SolveOptions;
  createdAt: string;
}

export class PfDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        netlist TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        label TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 冻结网表、初值、限值与容差为一个工况。 */
  createCase(name: string, netlist: Netlist, options: SolveOptions = {}): number {
    const stmt = this.db.prepare(
      'INSERT INTO cases (name, netlist, options, created_at) VALUES (?, ?, ?, ?)',
    );
    const r = stmt.run(name, JSON.stringify(netlist), JSON.stringify(options), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getCase(id: number): CaseRow | null {
    const row = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as
      | { id: number; name: string; netlist: string; options: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      netlist: JSON.parse(row.netlist),
      options: JSON.parse(row.options),
      createdAt: row.created_at,
    };
  }

  listCases(): { id: number; name: string; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT id, name, created_at FROM cases ORDER BY id')
      .all() as unknown as { id: number; name: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  saveRun(caseId: number, label: string, result: SolveResult): number {
    const stmt = this.db.prepare(
      'INSERT INTO runs (case_id, label, result, created_at) VALUES (?, ?, ?, ?)',
    );
    const r = stmt.run(caseId, label, JSON.stringify(result), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getRun(id: number): { id: number; caseId: number; label: string; result: SolveResult; createdAt: string } | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | { id: number; case_id: number; label: string; result: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      caseId: row.case_id,
      label: row.label,
      result: JSON.parse(row.result),
      createdAt: row.created_at,
    };
  }

  listRuns(caseId?: number): { id: number; caseId: number; label: string; createdAt: string }[] {
    const rows = (
      caseId === undefined
        ? this.db.prepare('SELECT id, case_id, label, created_at FROM runs ORDER BY id').all()
        : this.db.prepare('SELECT id, case_id, label, created_at FROM runs WHERE case_id = ? ORDER BY id').all(caseId)
    ) as unknown as { id: number; case_id: number; label: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, caseId: r.case_id, label: r.label, createdAt: r.created_at }));
  }
}

/** 默认数据目录：项目内 data/，可用 PF_DATA_DIR 覆盖。 */
export function defaultDbPath(): string {
  const dir = process.env.PF_DATA_DIR ?? path.join(process.cwd(), 'data');
  return path.join(dir, 'pf.sqlite');
}
