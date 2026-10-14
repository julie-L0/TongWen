# Agent 独立调优入口

2026-10-13。默认包为 semantic-agent-0.24；source-clauses / 0.25.3 与 scoped-clauses / 0.26.1 为显式候选，不自动切默认、不热更新正在运行的服务。来源/用途范围机制与真实失败见 [候选记录](../../../docs/AGENT_SCOPED_CLAUSES_20261013.md)，实际状态见 [统一入口](../../../docs/CURRENT_STATUS.md)。原正式验收保留，工程检查不是语义放行。

## 修改位置

- packs/default/system.md：实际语义 Prompt，已从 TS 原样迁出。
- packs/default/local-change.md：局部任务与修订交付约束，独立调优；不能修改source-scope.ts的核心权限/引用/确认守卫。
- packs/default/strategy.json：策略 ID、版本、按序组合的 Markdown 文件、受信任投影/反馈压缩的选择。
- context.ts：输入投影、证据缓存及反馈压缩。改这里是上下文调优代码变更，也需要工程检查。
- prompt.ts：旧 import 的兼容出口，不能再在这里另写第二套 Prompt。
- load.ts：只读装载并冻结数据资产；不装载包内 JS，不支持权限、预算、reviewProtocol 等执行参数。

支持 documents-v1、lean-documents-v1、候选 lean-source-clauses-v1/v2 受信任投影及 compact-v1/lean-v1 反馈注册项。v2 固定 scoped-v1 文档用途范围协议；候选条款/范围校验是核心约束，不是包内代码；工具描述和 Schema 仍在 schemas.ts，不能由 Prompt 关闭。

## 对照实验

从 default 复制一份新包，修改 ID/version 和 Markdown。包内不能通过 ../、绝对路径或符号链接越界读取资产。版本名相同但资产不同，也会记录不同指纹。

```powershell
Copy-Item -LiteralPath 'server/agent/tuning/packs/default' -Destination 'server/agent/tuning/packs/candidate-01' -Recurse
# 编辑 candidate-01 中的 strategy.json 和 system.md
pnpm agent:sample condition --strategy-dir server/agent/tuning/packs/candidate-01
```

这是原有真实 DeepSeek 脚本，会使用账号额度；只装载此前授权的个人合成业务资料，不读取 expected。主工作库不变，产物位于新建 runtime/agent-validation 目录。M3.1 的独立评测入口由测试方维护，这条命令仍是旧 M3 输入，不能登记为 M3.1 稳定性。

每次产物：input-snapshot.json（实际资料、角色、基线、预算、模型、策略快照及身份）、report.json、events.json、rounds.json、model-inputs.jsonl、freeze-check.json。请求审计移除 private reasoning，保留实际发给模型的其他消息和 tools；它不是包含私有思考的完整请求重放。API 密钥来自客户端请求头，不进入审计。

freeze-check 比较实际策略资产与 server/shared 执行代码起止指纹，非冻结样本保留但不用于同版本稳定性。测试方仍须冻结其驱动代码与输入、统一评分版本；不能只比较策略版本名，也不能拼接最好结果。一次只改 Prompt、模型配置或上下文组织中的一项。

## 工作台装载

固定业务材料的单轮候选执行：node tests/benchmark/workbench.ts run --case A03 --suite all --strategy source-clauses --execution-only --no-open。该模式不调用外部评分或校准，自动分保持 pending，本地复核另记；不能把候选定向样本混进原正式批次。来源条件、实际目标见证和分批校验见 Spec 第21节。CLI 校验路径/包存在后才允许模型调用。

默认使用 default。可在本地配置 AGENT_STRATEGY_DIR 为候选包路径后重启，装载失败明确报错，不静默回退。运行中包已冻结在内存，磁盘编辑不热更新。后续新启动引擎发现排队 Run 的执行身份不匹配会停止；旧完成报告仍可读。

调查浮窗的“查看逐轮调查记录”展示输入摘要、原生工具请求/参数、实际变化、用量和剩余待办；“查看执行反馈”按需读取真实工具结果。没有旧逐轮记录时明确说明，不补造轨迹。

完整请求审计只在开发时显式开启 AGENT_AUDIT_INPUTS=1，写 SQLite 的 agent_round_inputs；默认工作台关闭。真实样例脚本默认开启审计并导出，不通过公共报告或事件 API 返回请求快照。

## 核心边界与验证

策略只接收脱离状态的副本，没有 Store、文档写入或权限控制接口。范围、角色、真实证据、底本、版本、工具校验、覆盖/复核、确认、事务与撤销保持核心职责。提示能改变模型判断，不能绕过机械门禁；这不等于 Prompt 能保证语义正确。

```text
pnpm test:agent
pnpm test:boundaries
pnpm build
```

scripts/verify-agent-observability.ts 是明确标记的本地模型桩工程验证，可生成逐轮产物并用 --serve 打开隔离工作台；不是实时模型或业务验收通过证据。
