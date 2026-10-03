import * as http from "node:http";
import { getCase, getRun, insertCase, insertRun, listCases, listRuns } from "./db";
import { solveCase } from "./pf/solve";
import { validateNetlist, ValidationError } from "./pf/validate";
import { busesToCsv, branchesToCsv, compareRuns, loadScan } from "./analysis";
import { NetlistInput, SolveOptions } from "./types";

const PORT = Number(process.env.PF_PORT ?? 8730);

function send(res: http.ServerResponse, code: number, body: unknown, ctype = "application/json; charset=utf-8") {
  const s = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": ctype });
  res.end(s);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health")
        return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/cases") {
        const net = (await readBody(req)) as NetlistInput;
        validateNetlist(net);
        const id = insertCase(net);
        return send(res, 201, { id });
      }
      if (req.method === "GET" && url.pathname === "/cases")
        return send(res, 200, listCases());

      if (parts[0] === "cases" && parts.length >= 2) {
        const caseId = Number(parts[1]);
        const net = getCase(caseId);
        if (!net) return send(res, 404, { error: "工况不存在" });
        if (req.method === "GET" && parts.length === 2) return send(res, 200, net);
        if (req.method === "POST" && parts[2] === "solve") {
          const opts = (await readBody(req)) as SolveOptions & { label?: string };
          const result = solveCase(net, opts);
          const runId = insertRun(caseId, opts.label ?? null, opts, result);
          return send(res, 200, { runId, ...result });
        }
        if (req.method === "POST" && parts[2] === "scan") {
          const body = (await readBody(req)) as { factors: number[] } & SolveOptions;
          if (!Array.isArray(body.factors) || body.factors.length === 0)
            return send(res, 400, { error: "factors 必须为非空数组" });
          return send(res, 200, loadScan(net, body.factors, body));
        }
        if (req.method === "GET" && parts[2] === "runs") return send(res, 200, listRuns(caseId));
      }

      if (parts[0] === "runs" && parts.length >= 2) {
        const run = getRun(Number(parts[1]));
        if (!run) return send(res, 404, { error: "运行记录不存在" });
        if (req.method === "GET" && parts.length === 2) return send(res, 200, run);
        if (req.method === "GET" && parts[2] === "export") {
          const fmt = url.searchParams.get("format") ?? "json";
          const what = url.searchParams.get("what") ?? "buses";
          if (fmt === "csv") {
            const csv = what === "branches" ? branchesToCsv(run.result) : busesToCsv(run.result);
            return send(res, 200, csv, "text/csv; charset=utf-8");
          }
          return send(res, 200, run.result);
        }
      }

      if (req.method === "GET" && url.pathname === "/compare") {
        const a = getRun(Number(url.searchParams.get("run1")));
        const b = getRun(Number(url.searchParams.get("run2")));
        if (!a || !b) return send(res, 404, { error: "运行记录不存在" });
        return send(res, 200, compareRuns(a.result, b.result));
      }

      send(res, 404, { error: "未知路由" });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 422, { error: e.message });
      send(res, 500, { error: String(e) });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`潮流分析服务已启动: http://localhost:${PORT}`);
  });
}
