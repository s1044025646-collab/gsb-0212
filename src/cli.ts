import * as fs from "node:fs";
import { getCase, getRun, insertCase, insertRun, listCases, listRuns } from "./db";
import { solveCase } from "./pf/solve";
import { busesToCsv, branchesToCsv, compareRuns, loadScan } from "./analysis";
import { NetlistInput, SolveOptions, SolveResult } from "./types";

function printResult(r: SolveResult) {
  console.log(`收敛: ${r.converged}  停止原因: ${r.stopReason}`);
  console.log(`最终最大不平衡: ${r.finalMaxMismatch.toExponential(3)} pu  迭代次数: ${r.iterations.length}`);
  if (r.qEvents.length)
    for (const e of r.qEvents)
      console.log(`  [无功限值] 母线 ${e.bus}: Q=${e.qCalc.toFixed(4)} pu 越限, 固定于 ${e.limit.toFixed(4)} pu, 释放电压设定 ${e.vsetReleased} pu (PV->PQ)`);
  console.log("母线:");
  for (const b of r.buses)
    console.log(`  母线 ${b.id} [${b.type}] V=${b.vm.toFixed(4)}∠${b.vaDeg.toFixed(2)}°  Pg=${b.pGen.toFixed(2)}MW Qg=${b.qGen.toFixed(2)}Mvar  Pd=${b.pLoad.toFixed(2)} Qd=${b.qLoad.toFixed(2)}`);
  console.log("支路:");
  for (const br of r.branches)
    console.log(`  支路 ${br.id} (${br.from}-${br.to}): S_from=${br.pFrom.toFixed(2)}+j${br.qFrom.toFixed(2)}  S_to=${br.pTo.toFixed(2)}+j${br.qTo.toFixed(2)}  损耗=${br.pLoss.toFixed(3)}+j${br.qLoss.toFixed(3)}`);
  console.log(`全网: 有功损耗=${r.totalPLoss.toFixed(3)}MW 无功损耗=${r.totalQLoss.toFixed(3)}Mvar 充电无功=${r.totalQCharging.toFixed(3)}Mvar`);
  console.log(`平衡机: P=${r.slackP.toFixed(3)}MW Q=${r.slackQ.toFixed(3)}Mvar  平衡残差: dP=${r.balanceResidualP.toExponential(3)}MW dQ=${r.balanceResidualQ.toExponential(3)}Mvar`);
}

function parseOpts(args: string[]): SolveOptions & { label?: string } {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, "");
    const v = args[i + 1];
    o[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "import": {
    const net = JSON.parse(fs.readFileSync(rest[0], "utf-8")) as NetlistInput;
    const id = insertCase(net);
    console.log(`已导入工况 #${id} (${net.name})`);
    break;
  }
  case "cases":
    console.table(listCases());
    break;
  case "runs":
    console.table(listRuns(rest[0] ? Number(rest[0]) : undefined));
    break;
  case "solve": {
    const caseId = Number(rest[0]);
    const net = getCase(caseId);
    if (!net) throw new Error(`工况 #${caseId} 不存在`);
    const opts = parseOpts(rest.slice(1));
    const result = solveCase(net, opts);
    const runId = insertRun(caseId, opts.label ?? null, opts, result);
    console.log(`运行 #${runId}`);
    printResult(result);
    break;
  }
  case "show": {
    const run = getRun(Number(rest[0]));
    if (!run) throw new Error("运行记录不存在");
    printResult(run.result);
    break;
  }
  case "scan": {
    const caseId = Number(rest[0]);
    const net = getCase(caseId);
    if (!net) throw new Error(`工况 #${caseId} 不存在`);
    const factors = rest[1].split(",").map(Number);
    for (const p of loadScan(net, factors))
      console.log(`倍率 ${p.factor}: 收敛=${p.converged} Vmin=${p.minVm.toFixed(4)} Vmax=${p.maxVm.toFixed(4)} 损耗=${p.totalPLoss.toFixed(3)}MW 无功切换=${p.qViolations}次`);
    break;
  }
  case "compare": {
    const a = getRun(Number(rest[0])), b = getRun(Number(rest[1]));
    if (!a || !b) throw new Error("运行记录不存在");
    console.table(compareRuns(a.result, b.result));
    break;
  }
  case "export": {
    const run = getRun(Number(rest[0]));
    if (!run) throw new Error("运行记录不存在");
    const fmt = rest[1] ?? "json";
    const what = rest[2] ?? "buses";
    if (fmt === "csv") console.log(what === "branches" ? branchesToCsv(run.result) : busesToCsv(run.result));
    else console.log(JSON.stringify(run.result, null, 2));
    break;
  }
  default:
    console.log(`用法:
  node dist/src/cli.js import <netlist.json>        导入网表
  node dist/src/cli.js cases                        列出工况
  node dist/src/cli.js solve <caseId> [--tolerance 1e-8 --maxIter 50 --flatStart true --label 名称]
  node dist/src/cli.js show <runId>                 查看运行结果
  node dist/src/cli.js runs [caseId]                列出运行记录
  node dist/src/cli.js scan <caseId> <1.0,1.2,...>  负荷扫描
  node dist/src/cli.js compare <runId1> <runId2>    工况比较
  node dist/src/cli.js export <runId> [json|csv] [buses|branches]`);
}
