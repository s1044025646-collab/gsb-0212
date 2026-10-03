// API 冒烟测试（临时脚本，不作为构建产物的一部分维护）
const { PfDb } = require('../dist/src/db');
const { startServer } = require('../dist/src/api');
const fs = require('fs');

const db = new PfDb('data/pf.sqlite');
const srv = startServer(db, 8399);
(async () => {
  const j = (r) => r.json();
  console.log('health', await fetch('http://localhost:8399/api/health').then(j));
  const netlist = JSON.parse(fs.readFileSync('examples/three-bus.json', 'utf8'));
  const imp = await fetch('http://localhost:8399/api/cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'api示例', netlist }),
  }).then(j);
  console.log('import', imp);
  const sol = await fetch(`http://localhost:8399/api/cases/${imp.id}/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ save: true, label: 'api基态' }),
  }).then(j);
  console.log('solve converged', sol.result.converged, 'runId', sol.runId, 'residualP', sol.result.residualP);
  const scan = await fetch(`http://localhost:8399/api/cases/${imp.id}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ factors: [1.0, 1.6] }),
  }).then(j);
  for (const p of scan.points) console.log('scan', p.factor, p.converged, p.minVm.toFixed(5), 'switches', p.pvSwitches);
  const cmp = await fetch('http://localhost:8399/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runIdA: sol.runId, runIdB: sol.runId }),
  }).then(j);
  console.log('compare buses', cmp.diff.buses.length);
  const csv = await fetch(`http://localhost:8399/api/runs/${sol.runId}.csv`).then((r) => r.text());
  console.log('csv first line:', csv.split('\n')[0]);
  srv.close();
  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
