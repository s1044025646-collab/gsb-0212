import * as fs from "node:fs";
import * as path from "node:path";
import { insertCase, insertRun, getCase, getRun, db } from "../src/db";
import { solveCase } from "../src/pf/solve";
import { loadScan } from "../src/analysis";
import { NetlistInput } from "../src/types";

const net = JSON.parse(fs.readFileSync(path.join(__dirname, "../../examples/case3.json"), "utf-8")) as NetlistInput;

console.log("=== 1. 导入工况并求解基准负荷 ===");
const caseId = insertCase(net);
const base = solveCase(net, { label: "基准" } as never);
const runBase = insertRun(caseId, "基准负荷", {}, base);
console.log(`工况 #${caseId}, 运行 #${runBase}, 收敛=${base.converged}, ${base.stopReason}`);
for (const b of base.buses)
  console.log(`  母线 ${b.id} [${b.type}] V=${b.vm.toFixed(4)}∠${b.vaDeg.toFixed(2)}°  Qg=${b.qGen.toFixed(2)}Mvar`);
console.log(`  平衡残差 dP=${base.balanceResidualP.toExponential(3)}MW dQ=${base.balanceResidualQ.toExponential(3)}Mvar`);

console.log("\n=== 2. 负荷增加 80% 后求解 (触发 PV 无功越限) ===");
const heavy: NetlistInput = { ...net, buses: net.buses.map((b) => ({ ...b, pd: (b.pd ?? 0) * 1.8, qd: (b.qd ?? 0) * 1.8 })) };
const r2 = solveCase(heavy);
const runHeavy = insertRun(caseId, "负荷x1.8", {}, r2);
console.log(`运行 #${runHeavy}, 收敛=${r2.converged}, ${r2.stopReason}`);
for (const e of r2.qEvents)
  console.log(`  [PV->PQ] 母线 ${e.bus}: 计算无功 ${(e.qCalc * net.sbase).toFixed(2)}Mvar 越限, 固定于 ${(e.limit * net.sbase).toFixed(2)}Mvar, 电压设定 ${e.vsetReleased}pu 不再受控`);
for (const b of r2.buses)
  console.log(`  母线 ${b.id} [${b.type}] V=${b.vm.toFixed(4)}∠${b.vaDeg.toFixed(2)}°  Qg=${b.qGen.toFixed(2)}Mvar`);
console.log(`  平衡残差 dP=${r2.balanceResidualP.toExponential(3)}MW dQ=${r2.balanceResidualQ.toExponential(3)}Mvar`);

console.log("\n=== 3. 负荷扫描 0.8 ~ 1.8 ===");
for (const p of loadScan(net, [0.8, 1.0, 1.2, 1.4, 1.6, 1.8]))
  console.log(`  倍率 ${p.factor.toFixed(1)}: 收敛=${p.converged} Vmin=${p.minVm.toFixed(4)} Vmax=${p.maxVm.toFixed(4)} 损耗=${p.totalPLoss.toFixed(3)}MW 无功切换=${p.qViolations}`);

console.log("\n=== 4. 模拟重启: 关闭并重新打开数据库, 复核原工况 ===");
db.close();
delete require.cache[require.resolve("../src/db")];
const db2 = require("../src/db") as typeof import("../src/db");
const net2 = db2.getCase(caseId)!;
const rerun = solveCase(net2, (db2.getRun(runBase)!.options ?? {}) as never);
const stored = db2.getRun(runBase)!.result;
const dv = Math.max(...rerun.buses.map((b, i) => Math.abs(b.vm - stored.buses[i].vm)));
console.log(`  重启后重解与冻结结果最大电压偏差: ${dv.toExponential(3)} pu (应 < 1e-9)`);
console.log(`  冻结运行 #${runBase} 停止原因: ${stored.stopReason}`);

