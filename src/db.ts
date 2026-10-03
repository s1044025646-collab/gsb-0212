import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { NetlistInput, SolveOptions, SolveResult } from "./types";

const DATA_DIR = process.env.PF_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.PF_DB_PATH ?? path.join(DATA_DIR, "pf.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sbase REAL NOT NULL,
  netlist TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  label TEXT,
  options TEXT NOT NULL,
  result TEXT NOT NULL,
  converged INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function insertCase(net: NetlistInput): number {
  const r = db.prepare("INSERT INTO cases (name, sbase, netlist) VALUES (?, ?, ?)").run(
    net.name, net.sbase, JSON.stringify(net)
  );
  return Number(r.lastInsertRowid);
}

export function getCase(id: number): NetlistInput | null {
  const row = db.prepare("SELECT netlist FROM cases WHERE id = ?").get(id) as { netlist: string } | undefined;
  return row ? (JSON.parse(row.netlist) as NetlistInput) : null;
}

export function listCases(): { id: number; name: string; sbase: number; created_at: string }[] {
  return db.prepare("SELECT id, name, sbase, created_at FROM cases ORDER BY id").all() as never;
}

export function insertRun(caseId: number, label: string | null, options: SolveOptions, result: SolveResult): number {
  const r = db.prepare("INSERT INTO runs (case_id, label, options, result, converged) VALUES (?, ?, ?, ?, ?)").run(
    caseId, label, JSON.stringify(options), JSON.stringify(result), result.converged ? 1 : 0
  );
  return Number(r.lastInsertRowid);
}

export function getRun(id: number): { id: number; case_id: number; label: string | null; options: SolveOptions; result: SolveResult; converged: boolean; created_at: string } | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    case_id: row.case_id as number,
    label: row.label as string | null,
    options: JSON.parse(row.options as string),
    result: JSON.parse(row.result as string),
    converged: (row.converged as number) === 1,
    created_at: row.created_at as string,
  };
}

export function listRuns(caseId?: number) {
  const rows = (caseId == null
    ? db.prepare("SELECT id, case_id, label, converged, created_at FROM runs ORDER BY id").all()
    : db.prepare("SELECT id, case_id, label, converged, created_at FROM runs WHERE case_id = ? ORDER BY id").all(caseId)) as never[];
  return rows;
}
