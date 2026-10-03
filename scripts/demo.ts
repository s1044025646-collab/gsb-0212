/**
 * 演示：负荷增加前后的电压变化与 PV 无功越限切换，
 * 输出真实残差，并模拟重启后从 SQLite 复核原工况。
 */
import { PfDb, defaultDbPath } from '../src/db';
import { solve } from '../src/solve';
import { compareResults } from '../src/analysis';
import { Netlist } from '../src/types';

const net: Netlist = {
  sbase: 100,
  buses: [
    { id: 1, type: 'slack', vm: 1.03, va: 0, pl: 0, ql: 0, pg: 0, qg: 0 },
    { id: 2, type: 'pv', vm: 1.01, va: 0, pl: 0.2, ql: 0.1, pg: 0.8, qg: 0, qmin: -0.4, qmax: 0.2 },
    { id: 3, type: 'pq', vm: 1.0, va: 0, pl: 0.9, ql: 0.4, pg: 0, qg: 0 },
  ],
  branches: [
    { id: 1, from: 1, to: 2, r: 0.02, x: 0.08, b: 0.06 },
    { id: 2, from: 1, to: 3, r: 0.03, x: 0.12, b: 0.05 },
    { id: 3, from: 2, to: 3, r: 0.025, x: 0.1, b: 0.04 },
  ],
};

function showVoltages(tag: string, r: ReturnType<typeof solve>): void {
  console.log(`\n== ${tag} ==  收敛=${r.converged} 停止原因=${r.stopReason}`);
  for (const b of r.buses) {
    console.log(
      `  母线 ${b.id} [${b.effectiveType}] V=${b.vm.toFixed(5)}∠${((b.va * 180) / Math.PI).toFixed(3)}°  Qg=${b.qg.toFixed(4)}`,
    );
  }
  console.log(`  真实残差: P=${r.residualP.toExponential(4)} Q=${r.residualQ.toExponential(4)} (标幺, 等于网损+充电净额)`);
  console.log(`  最终功率不平衡: ${r.finalMismatch.toExponential(3)}`);
  for (const s of r.pvSwitches) {
    console.log(
      `  PV->PQ 切换: 母线 ${s.busId} 越 ${s.limit}，Qg 固定 ${s.qFixed}（计算值 ${s.qComputed.toFixed(4)}），` +
        `原电压设定 ${s.originalVSet} 不再受控`,
    );
  }
}

function main(): void {
  const dbPath = defaultDbPath();
  console.log(`数据库: ${dbPath}`);
  const db = new PfDb(dbPath);
  const caseId = db.createCase('演示-三母线', net, { tol: 1e-10 });
  console.log(`已冻结工况 caseId=${caseId}`);

  const before = solve(net, { tol: 1e-10 });
  showVoltages('负荷增加前', before);
  db.saveRun(caseId, '负荷增加前', before);

  // 负荷增加 60%
  const heavier: Netlist = {
    ...net,
    buses: net.buses.map((b) => ({ ...b, pl: b.pl * 1.6, ql: b.ql * 1.6 })),
  };
  const after = solve(heavier, { tol: 1e-10 });
  showVoltages('负荷增加 60% 后', after);
  db.saveRun(caseId, '负荷增加后', after);

  console.log('\n== 负荷增加前后电压变化 (后-前) ==');
  const diff = compareResults(before, after);
  for (const d of diff.buses) {
    console.log(`  母线 ${d.id}: ΔV=${d.dVm.toFixed(5)}  Δθ=${((d.dVa * 180) / Math.PI).toFixed(3)}°  类型 ${d.typeA}->${d.typeB}`);
  }
  db.close();

  // 模拟重启：重新打开数据库复核原工况
  console.log('\n== 重启后复核原工况 ==');
  const db2 = new PfDb(dbPath);
  const c = db2.getCase(caseId)!;
  const recheck = solve(c.netlist, c.options);
  const same =
    recheck.converged === before.converged &&
    recheck.buses.every((b, i) => b.vm === before.buses[i].vm && b.va === before.buses[i].va);
  console.log(`复核工况 "${c.name}" (id=${c.id})：结果与首次完全一致 = ${same}`);
  console.log(`复核残差: P=${recheck.residualP.toExponential(4)} Q=${recheck.residualQ.toExponential(4)}`);
  db2.close();
}

main();
