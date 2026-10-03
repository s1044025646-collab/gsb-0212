#!/usr/bin/env node
import * as fs from 'node:fs';
import { PfDb, defaultDbPath } from './db';
import { solve } from './solve';
import { validateNetlist } from './network';
import { compareResults, loadScan } from './analysis';
import { startServer, runToCsv } from './api';
import { Netlist, SolveOptions, SolveResult } from './types';

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printSummary(r: SolveResult): void {
  console.log(`收敛: ${r.converged}  停止原因: ${r.stopReason}  最终不平衡: ${r.finalMismatch.toExponential(3)}`);
  console.log(`全网残差: P=${r.residualP.toExponential(3)}  Q=${r.residualQ.toExponential(3)} (标幺)`);
  console.log('母线:');
  for (const b of r.buses) {
    console.log(
      `  母线 ${b.id} [${b.type}${b.effectiveType !== b.type ? '->' + b.effectiveType : ''}] ` +
        `V=${b.vm.toFixed(5)}∠${((b.va * 180) / Math.PI).toFixed(3)}° ` +
        `P=${b.pInj.toFixed(5)} Q=${b.qInj.toFixed(5)} Qg=${b.qg.toFixed(5)}`,
    );
  }
  console.log('支路:');
  for (const br of r.branches) {
    console.log(
      `  支路 ${br.id} (${br.from}->${br.to}) S_from=${br.pFrom.toFixed(5)}+j${br.qFrom.toFixed(5)} ` +
        `S_to=${br.pTo.toFixed(5)}+j${br.qTo.toFixed(5)} 损耗=${br.pLoss.toFixed(5)}+j${br.qLoss.toFixed(5)}`,
    );
  }
  if (r.pvSwitches.length) {
    console.log('PV->PQ 切换:');
    for (const s of r.pvSwitches) {
      console.log(
        `  母线 ${s.busId}: 越 ${s.limit}，Qg 固定为 ${s.qFixed}（计算值 ${s.qComputed.toFixed(5)}），` +
          `原电压设定 ${s.originalVSet} 不再受控`,
      );
    }
  }
}

const USAGE = `用法: node dist/cli.js <命令> [参数]
  serve [--port N]                      启动 API 服务（默认端口 8300，或 PF_PORT）
  import <netlist.json> --name N [--options opts.json]   导入并冻结工况
  cases                                 列出工况
  validate <netlist.json>               结构校验
  solve <netlist.json> [--options opts.json]             直接求解（不落库）
  solve-case <caseId> [--save --label L]  从数据库复核并求解工况
  scan <caseId> <f1,f2,...>             负荷扫描
  compare <runIdA> <runIdB>             工况比较
  export <runId> --format json|csv --out file           导出运行结果
  runs [--case N]                       列出运行记录
数据目录: ./data（可用 PF_DATA_DIR 覆盖）`;

export function main(argv: string[]): void {
  const [cmd, ...args] = argv;
  const db = new PfDb(defaultDbPath());
  try {
    switch (cmd) {
      case 'serve': {
        const port = Number(argValue(args, '--port') ?? process.env.PF_PORT ?? 8300);
        startServer(db, port);
        return;
      }
      case 'import': {
        const netlist = readJson(args[0]) as Netlist;
        const errors = validateNetlist(netlist);
        if (errors.length) throw new Error(`网表校验失败: ${errors.join('; ')}`);
        const optFile = argValue(args, '--options');
        const options = optFile ? (readJson(optFile) as SolveOptions) : {};
        const id = db.createCase(argValue(args, '--name') ?? 'case', netlist, options);
        console.log(`已导入工况 id=${id}`);
        break;
      }
      case 'cases':
        console.log(JSON.stringify(db.listCases(), null, 2));
        break;
      case 'validate': {
        const errors = validateNetlist(readJson(args[0]) as Netlist);
        console.log(errors.length ? `校验失败:\n${errors.join('\n')}` : '校验通过');
        break;
      }
      case 'solve': {
        const netlist = readJson(args[0]) as Netlist;
        const optFile = argValue(args, '--options');
        const options = optFile ? (readJson(optFile) as SolveOptions) : {};
        printSummary(solve(netlist, options));
        break;
      }
      case 'solve-case': {
        const c = db.getCase(Number(args[0]));
        if (!c) throw new Error('工况不存在');
        const result = solve(c.netlist, c.options);
        printSummary(result);
        if (args.includes('--save')) {
          const runId = db.saveRun(c.id, argValue(args, '--label') ?? '', result);
          console.log(`已保存运行 runId=${runId}`);
        }
        break;
      }
      case 'scan': {
        const c = db.getCase(Number(args[0]));
        if (!c) throw new Error('工况不存在');
        const factors = args[1].split(',').map(Number);
        for (const p of loadScan(c.netlist, factors, c.options)) {
          console.log(
            `负荷×${p.factor}: 收敛=${p.converged} Vmin=${p.minVm.toFixed(5)} Vmax=${p.maxVm.toFixed(5)} ` +
              `PV切换=${p.pvSwitches} 残差P=${p.residualP.toExponential(2)}`,
          );
        }
        break;
      }
      case 'compare': {
        const a = db.getRun(Number(args[0]));
        const b = db.getRun(Number(args[1]));
        if (!a || !b) throw new Error('运行记录不存在');
        const diff = compareResults(a.result, b.result);
        console.log(JSON.stringify(diff, null, 2));
        break;
      }
      case 'export': {
        const run = db.getRun(Number(args[0]));
        if (!run) throw new Error('运行记录不存在');
        const format = argValue(args, '--format') ?? 'json';
        const out = format === 'csv' ? runToCsv(run.result) : JSON.stringify(run.result, null, 2);
        const outFile = argValue(args, '--out');
        if (outFile) {
          fs.writeFileSync(outFile, out);
          console.log(`已导出到 ${outFile}`);
        } else {
          console.log(out);
        }
        break;
      }
      case 'runs': {
        const caseId = argValue(args, '--case');
        console.log(JSON.stringify(db.listRuns(caseId ? Number(caseId) : undefined), null, 2));
        break;
      }
      default:
        console.log(USAGE);
    }
  } finally {
    if (process.argv[2] !== 'serve') db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
