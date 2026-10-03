# 平衡交流电网潮流与无功限值分析后端

离线稳态潮流计算服务, 仅提供 API 与 CLI (无前端)。使用 TypeScript + Node.js + SQLite (`node:sqlite`, 无原生编译依赖), 在 Windows 本地运行, 不依赖 Docker / WSL / 外部在线服务。

## 功能范围

- 小规模**平衡交流**电网的离线稳态潮流: 母线、支路 (R/X/线路充电电纳)、发电与负荷、基准容量、工况版本管理
- 标幺制, 注入约定: **发电为正注入, 负荷为负注入**
- 母线类型: 平衡 (slack) / PQ / PV; 每个网络**恰有一个平衡母线**且必须连通
- 自行构建复数节点导纳矩阵与极坐标潮流方程, Newton–Raphson 求解 (解析雅可比, 部分主元高斯消元), 未使用任何现成潮流求解器
- PV 无功限值: 越限时按确定性策略 (每次切换越限最大者, 切换后不回切) 转为固定无功 PQ 母线并重解, 记录切换事件与被释放的电压设定值
- 每步迭代记录功率不平衡与步长; 雅可比奇异 / 非有限电压 / 迭代预算耗尽均标记**不收敛**, 不会把最后一次迭代当作有效潮流
- 报告母线注入、支路两端复功率、线路损耗、线路充电无功与全网平衡残差 (充电无功与负荷/发电同口径, 残差 = 发电 - 负荷 - 损耗)
- 网表导入、结构校验、求解、无功限值追踪、负荷扫描、工况比较、JSON/CSV 导出
- SQLite 冻结网表、初值、限值与容差, 重启后可复核原工况

**明确不做**: 非额定变比 / 移相变压器、经济调度、暂态仿真、三相不平衡、真实电网连接。不同初值可能收敛到不同解或失败, 本工具不宣称解的唯一性。

## 环境要求

- Node.js >= 22.5 (使用内置 `node:sqlite`; 开发环境为 Node 25)
- Windows 本地, 无需其他依赖

## 快速开始

```powershell
npm install        # 安装开发依赖 (typescript 等)
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务 (默认端口 8730)
npm run demo       # 端到端演示: 负荷增加前后电压变化 + PV 无功越限切换 + 重启复核
```

可配置项 (环境变量):

- `PF_PORT`: HTTP 端口, 默认 `8730`
- `PF_DATA_DIR`: 数据目录, 默认项目内 `data/`
- `PF_DB_PATH`: SQLite 文件路径, 默认 `<PF_DATA_DIR>/pf.db`

## 网表格式 (JSON)

```json
{
  "name": "三母线示例网",
  "sbase": 100,
  "buses": [
    { "id": 1, "type": "slack", "vset": 1.02, "va": 0 },
    { "id": 2, "type": "pv", "pg": 60, "vset": 1.0, "qmin": -50, "qmax": 5 },
    { "id": 3, "type": "pq", "pd": 90, "qd": 30 }
  ],
  "branches": [
    { "id": 1, "from": 1, "to": 2, "r": 0.02, "x": 0.06, "b": 0.06 }
  ]
}
```

- `pg/pd/qd` 单位 MW/Mvar; `qmin/qmax` 单位 Mvar (仅 PV 有效)
- `r/x/b` 为系统基准下的标幺值, `b` 为线路**总**充电电纳 (两端各半)
- 校验规则: 恰一个平衡母线、连通 (无孤岛)、无零阻抗支路、无自环、参数有限

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/cases` | 导入网表 (body 为网表 JSON) |
| GET | `/cases` / `/cases/:id` | 列出 / 查看工况 |
| POST | `/cases/:id/solve` | 求解潮流, body 可含 `tolerance` `maxIter` `flatStart` `enforceQLimits` `label` |
| POST | `/cases/:id/scan` | 负荷扫描, body: `{"factors":[0.8,1.0,1.2]}` |
| GET | `/cases/:id/runs` | 运行记录 |
| GET | `/runs/:id` | 查看冻结的求解结果 |
| GET | `/runs/:id/export?format=csv&what=buses` | 导出 JSON/CSV (`what=branches` 导出支路) |
| GET | `/compare?run1=1&run2=2` | 工况比较 (电压幅值/相角差) |

## CLI

```powershell
npm run cli -- import examples/case3.json     # 导入网表
npm run cli -- cases                          # 列出工况
npm run cli -- solve 1 --label 基准           # 求解 (可选 --tolerance 1e-8 --maxIter 50 --flatStart true)
npm run cli -- show 1                         # 查看运行结果
npm run cli -- scan 1 0.8,1.0,1.2,1.6,1.8     # 负荷扫描
npm run cli -- compare 1 2                    # 工况比较
npm run cli -- export 1 csv buses             # CSV 导出
```

## 求解与收敛诊断

- 未知量: 非平衡母线相角 + PQ 母线电压幅值; PV 母线幅值固定于 `vset`, 不同时强制无功
- 每次迭代记录 `{ iter, maxMismatch, stepNorm }`; 停止原因写入结果 `stopReason`
- 不收敛情形: 雅可比奇异、电压非有限/非正、迭代预算耗尽、无功切换次数耗尽
- PV 越限处理: 计算发电无功, 越限最大者固定于被越限值并转 PQ, 记录 `qEvents` (含被释放的 `vsetReleased`), 重新求解; 已切换母线不回切, 避免振荡

## 测试

`npm test` 覆盖: 两母线 (由已知电压反算注入构造基准)、三母线含并联线路与充电电纳、雅可比中心差分核对、两端功率与损耗一致性、PV 转 PQ、零阻抗支路、孤岛、平衡母线数量、明确不收敛输入、母线编号重排不变性、标幺基准一致换算、初值敏感性。

## 已知限制

- 仅极坐标 NR (带简单阻尼), 无最优乘子/信赖域; 病态系统可能失败而非找到其他解
- PV 转 PQ 后不回切 (确定性策略), 结果可能依赖切换顺序
- 不支持非额定变比、移相器、直流线、分布式 slack
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning, 不影响功能
