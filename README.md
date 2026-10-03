# 平衡交流电网潮流与无功限值分析后端

基于 TypeScript + Node.js + SQLite 的离线稳态潮流计算服务，仅提供 API 与 CLI，无前端。
面向小规模**平衡**交流电网的稳态分析：管理母线、支路、发电/负荷、基准容量与工况版本，
自研复数节点导纳矩阵与极坐标 Newton–Raphson 求解器，支持 PV 发电机无功限值追踪。

## 范围与假设

- 只做离线稳态潮流：不做经济调度、暂态仿真、三相不平衡分析，不连接真实电网。
- 线路模型为 π 型等值（串联 r+jx，充电电纳 b 两端各半）；**不含**非额定变比与移相变压器。
- 每个输入网络必须**连通**且**恰有一个平衡母线**，导入时强制校验。
- 全线采用标幺制：功率、阻抗、电纳均以 `sbase`（MVA）为基准；电压基准隐含一致。
- 注入为正约定：母线净注入 `P = Pg - Pl`、`Q = Qg - Ql`，正值表示注入电网（发电方向），
  负荷为正值表示消耗。线路充电无功与负荷、发电在同一口径下统计（计入母线注入与全网残差）。
- PV 母线的 `qg` 字段被忽略（无功由求解决定），不能同时强制给定无功。
- 不同初值可能收敛到不同解或失败，本工具**不宣称唯一物理解**。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，无需原生编译、Docker、WSL 或任何在线服务）。
- 依赖仅 `typescript` 与 `@types/node`（开发依赖）。

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 演示：负荷增加前后电压变化 + PV 无功越限切换 + 重启复核
npm start         # 启动 API 服务（默认端口 8300）
```

配置项（环境变量）：

- `PF_PORT`：API 端口（默认 8300，CLI 可用 `--port` 覆盖）。
- `PF_DATA_DIR`：数据目录（默认项目内 `./data`，SQLite 文件为 `pf.sqlite`）。

## 网表格式（JSON）

见 `examples/three-bus.json`：

```json
{
  "sbase": 100,
  "buses": [
    { "id": 1, "type": "slack", "vm": 1.03, "va": 0, "pl": 0, "ql": 0, "pg": 0, "qg": 0 },
    { "id": 2, "type": "pv", "vm": 1.01, "va": 0, "pl": 0.2, "ql": 0.1, "pg": 0.8, "qg": 0, "qmin": -0.4, "qmax": 0.2 }
  ],
  "branches": [
    { "id": 1, "from": 1, "to": 2, "r": 0.02, "x": 0.08, "b": 0.06 }
  ]
}
```

- `vm`/`va`：初值；对平衡母线为参考电压，对 PV 母线为电压设定值。
- `qmin`/`qmax`：仅 PV 母线有效，发电机无功上下限（标幺）。

## CLI

```powershell
node dist/src/cli.js validate examples/three-bus.json   # 结构校验
node dist/src/cli.js solve examples/three-bus.json      # 直接求解（不落库）
node dist/src/cli.js import examples/three-bus.json --name 基态   # 冻结工况到 SQLite
node dist/src/cli.js cases                              # 列出工况
node dist/src/cli.js solve-case 1 --save --label 基态   # 从数据库复核求解并保存运行
node dist/src/cli.js scan 1 1.0,1.2,1.4,1.6             # 负荷扫描
node dist/src/cli.js compare 1 2                        # 比较两个运行记录
node dist/src/cli.js export 1 --format csv --out r.csv  # 导出 JSON/CSV
node dist/src/cli.js runs --case 1                      # 列出运行记录
node dist/src/cli.js serve --port 8300                  # 启动 API
```

## API（REST，JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/validate` | 结构校验，body: `{netlist}` |
| POST | `/api/solve` | 直接求解，body: `{netlist, options?}` |
| POST | `/api/cases` | 导入并冻结工况，body: `{name, netlist, options?}` |
| GET | `/api/cases` / `/api/cases/:id` | 列出/读取工况 |
| POST | `/api/cases/:id/solve` | 求解工况，body: `{options?, label?, save?}` |
| POST | `/api/cases/:id/scan` | 负荷扫描，body: `{factors: number[]}` |
| POST | `/api/compare` | 工况比较，body: `{runIdA, runIdB}` |
| GET | `/api/runs?caseId=` / `/api/runs/:id` | 运行记录 |
| GET | `/api/runs/:id.csv` | CSV 导出 |

求解选项 `options`：`tol`（功率不平衡容差，默认 1e-8）、`maxIter`（默认 50）、
`qTol`（限值裕度，默认 1e-6）、`enforceQLimits`（默认 true）。

## 数值方法与收敛诊断

- 导纳矩阵由支路参数直接构造（`src/ybus.ts`），极坐标 NR 在 `src/powerflow.ts`：
  未知量为非平衡母线相角与 PQ 母线电压幅值，雅可比解析构造，线性方程用部分主元高斯消元。
- 每次迭代记录最大功率不平衡与修正步长（`iterations`），停止原因：
  `converged` / `max_iter_exceeded` / `jacobian_singular` / `non_finite_state`。
  未收敛时 `converged=false`，最后迭代的电压**不作为有效潮流**结论。
- PV 无功限值：收敛后按母线编号升序找出全部越限 PV 母线，一次性转为 PQ 并把无功固定在
  被越的限值上重新求解；转换不可逆、轮数不超过 PV 母线数，保证确定性与终止性。
  切换记录（`pvSwitches`）包含原电压设定值（切换后不再受控）与越限计算值。
- 结果包含：各母线注入、支路两端复功率、线路损耗、全网平衡残差
  （所有母线注入之和 = 网损 + 充电净额）。

## 持久化

SQLite（`node:sqlite`）两张表：`cases` 冻结网表 JSON、初值、限值与容差；
`runs` 保存每次求解的完整结果。重启后可用 `solve-case <id>` 复核原工况，结果逐位一致
（演示脚本与测试均覆盖）。

## 测试

`npm test` 运行 12 项测试（`test/powerflow.test.ts`）：

- 两母线：用独立复数计算由已知电压反算注入构造基准，求解恢复该电压；
- 三母线：含并联线路与充电电纳，校验残差 = 损耗、两端功率平衡；
- PV 转 PQ：越限切换、限值固定、原电压设定失效；
- 非法输入：零阻抗支路、孤岛、平衡母线数量错误；
- 明确不收敛：过重负荷耗尽迭代预算且不作为有效潮流；
- 雅可比与有限差分一致；母线编号重排不变性；标幺基准一致换算
  （阻抗标幺 ∝ Sbase，电纳标幺 ∝ 1/Sbase，功率标幺 ∝ 1/Sbase）；
- SQLite 冻结工况重启后复核一致；PV 母线 `qg` 给定值被忽略。

## 已知限制

- 仅平衡正序模型，无变压器变比/移相、无独立并联电抗器元件（可并入母线负荷口径）。
- PV 转 PQ 后不回切（即使后续工况下限值恢复）；多解情形不做解的选择与稳定性判断。
- 雅可比为满阵高斯消元，面向小规模网络（数十至数百节点），未做稀疏优化。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
