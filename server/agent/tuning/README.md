# Agent 策略资产

本目录维护 Prompt 与受信任的输入投影。公开运行入口按根目录 `submission-version.json` 选择已冻结的策略包；当前实际包位于 `packs/scoped-clauses/`。

## 主要文件

| 位置 | 内容 |
| --- | --- |
| `packs/*/strategy.json` | 包标识、版本、Markdown组合顺序与投影选择 |
| `packs/*/system.md` | 模型任务与工具使用指令 |
| `packs/*/local-change.md` | 局部修改与修订范围 |
| `packs/*/efficient-investigation.md` | 调查效率约束 |
| `lean-context.ts` | 上下文投影与工具反馈压缩 |
| `load.ts` | 只读装载与冻结策略资产 |

## 执行边界

程序负责范围、角色、真实引用、版本与确认保护。Prompt和策略配置不能关闭这些保护，也不能写入权限、预算或复核协议参数。

策略在服务启动与任务创建时记录身份；修改文件后应重新记录身份并验证，不对正在运行的任务热更新。相同版本名称但不同资产会产生不同指纹，旧建议不能直接沿用。

此源码交付提供启动与界面构建入口。开发期的完整benchmark驱动与私有运行资料未随公开仓库交付；不依赖缺失的历史脚本运行本原型。

[返回项目首页](../../../README.md)
