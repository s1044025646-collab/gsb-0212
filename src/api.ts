import * as http from 'node:http';
import { PfDb } from './db';
import { solve } from './solve';
import { validateNetlist } from './network';
import { compareResults, loadScan } from './analysis';
import { Netlist, SolveOptions } from './types';

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 启动 REST API 服务。端口可用 PF_PORT 或参数配置。 */
export function startServer(db: PfDb, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      // 健康检查
      if (req.method === 'GET' && path === '/api/health') {
        return sendJson(res, 200, { ok: true });
      }
      // 网表校验
      if (req.method === 'POST' && path === '/api/validate') {
        const body = (await readBody(req)) as { netlist: Netlist };
        return sendJson(res, 200, { errors: validateNetlist(body.netlist) });
      }
      // 导入工况（冻结网表+选项）
      if (req.method === 'POST' && path === '/api/cases') {
        const body = (await readBody(req)) as { name: string; netlist: Netlist; options?: SolveOptions };
        const errors = validateNetlist(body.netlist);
        if (errors.length) return sendJson(res, 400, { errors });
        const id = db.createCase(body.name ?? 'case', body.netlist, body.options ?? {});
        return sendJson(res, 201, { id });
      }
      if (req.method === 'GET' && path === '/api/cases') {
        return sendJson(res, 200, db.listCases());
      }
      const caseMatch = path.match(/^\/api\/cases\/(\d+)(\/solve|\/scan)?$/);
      if (caseMatch) {
        const id = Number(caseMatch[1]);
        const c = db.getCase(id);
        if (!c) return sendJson(res, 404, { error: '工况不存在' });
        if (req.method === 'GET' && !caseMatch[2]) return sendJson(res, 200, c);
        if (req.method === 'POST' && caseMatch[2] === '/solve') {
          const body = (await readBody(req)) as { options?: SolveOptions; label?: string; save?: boolean };
          const result = solve(c.netlist, { ...c.options, ...(body.options ?? {}) });
          let runId: number | undefined;
          if (body.save) runId = db.saveRun(id, body.label ?? '', result);
          return sendJson(res, 200, { result, runId });
        }
        if (req.method === 'POST' && caseMatch[2] === '/scan') {
          const body = (await readBody(req)) as { factors: number[]; options?: SolveOptions };
          const points = loadScan(c.netlist, body.factors, { ...c.options, ...(body.options ?? {}) });
          return sendJson(res, 200, { points });
        }
      }
      // 直接求解（不落库）
      if (req.method === 'POST' && path === '/api/solve') {
        const body = (await readBody(req)) as { netlist: Netlist; options?: SolveOptions };
        return sendJson(res, 200, { result: solve(body.netlist, body.options ?? {}) });
      }
      // 工况比较：两个已保存运行，或一个运行对当前工况
      if (req.method === 'POST' && path === '/api/compare') {
        const body = (await readBody(req)) as { runIdA: number; runIdB: number };
        const a = db.getRun(body.runIdA);
        const b = db.getRun(body.runIdB);
        if (!a || !b) return sendJson(res, 404, { error: '运行记录不存在' });
        return sendJson(res, 200, { diff: compareResults(a.result, b.result) });
      }
      if (req.method === 'GET' && path === '/api/runs') {
        const caseId = url.searchParams.get('caseId');
        return sendJson(res, 200, db.listRuns(caseId ? Number(caseId) : undefined));
      }
      const runMatch = path.match(/^\/api\/runs\/(\d+)(\.csv)?$/);
      if (req.method === 'GET' && runMatch) {
        const run = db.getRun(Number(runMatch[1]));
        if (!run) return sendJson(res, 404, { error: '运行记录不存在' });
        if (runMatch[2] === '.csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
          return res.end(runToCsv(run.result));
        }
        return sendJson(res, 200, run);
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, () => {
    console.log(`潮流分析 API 已启动: http://localhost:${port}/api/health`);
  });
  return server;
}

export function runToCsv(result: import('./types').SolveResult): string {
  const lines: string[] = [];
  lines.push('section,id,vm,va_deg,p_inj,q_inj,pg,qg,pl,ql,type,effective_type');
  for (const b of result.buses) {
    lines.push(
      ['bus', b.id, b.vm, (b.va * 180) / Math.PI, b.pInj, b.qInj, b.pg, b.qg, b.pl, b.ql, b.type, b.effectiveType].join(','),
    );
  }
  lines.push('section,id,from,to,p_from,q_from,p_to,q_to,p_loss,q_loss,,');
  for (const br of result.branches) {
    lines.push(
      ['branch', br.id, br.from, br.to, br.pFrom, br.qFrom, br.pTo, br.qTo, br.pLoss, br.qLoss, '', ''].join(','),
    );
  }
  lines.push(`residual_p,,${result.residualP}`);
  lines.push(`residual_q,,${result.residualQ}`);
  lines.push(`converged,,${result.converged}`);
  lines.push(`stop_reason,,${result.stopReason}`);
  return lines.join('\n') + '\n';
}
