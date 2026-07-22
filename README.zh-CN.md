[English](./README.md) | 简体中文

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/hero-light.svg">
  <img alt="BisectRun — 面向编码智能体的 git-bisect" src="assets/hero-light.svg">
</picture>

# BisectRun

> git-bisect，但面向 **编码智能体（Coding Agents）**。定位两次 Agent 运行产生分歧的那一个 span。

[![npm 版本](https://img.shields.io/npm/v/bisectrun?label=npm&logo=npm)](https://www.npmjs.com/package/bisectrun)
[![license](https://img.shields.io/npm/l/bisectrun?color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/bisectrun?logo=node.js&color=green)](https://www.nodejs.org)
[![tests](https://img.shields.io/badge/tests-10%20passing-brightgreen)](#测试)
[![typecheck](https://img.shields.io/badge/tsc-strict-blue?logo=typescript)](./tsconfig.json)

上周那次修复 Bug 的 **Agent** 还跑得干干净净。今天的运行却在 200 个工具调用里的某个地方炸了。`git bisect` 能找到出问题的 commit —— 但谁来找到出问题的那一步？**BisectRun** 回放两份 Claude Code 会话记录，按 span 语义对齐两棵 span 树，并精准定位 **首次分歧（first divergence）**：那次通过的运行与失败的运行究竟在哪一个工具调用上分道扬镳。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/atlas-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/atlas-light.svg">
  <img alt="BisectRun 架构图" src="assets/atlas-light.svg">
</picture>

---

## <img src="https://api.iconify.design/tabler/rocket.svg" width="26" align="top"> 快速开始

一条命令安装并对两次会话做 bisect：

```bash
npx bisect-run@latest failed-session.jsonl good-session.jsonl
```

启动左右并排的差异 UI：

```bash
npx bisect-run@latest failed-session.jsonl good-session.jsonl --ui
# → BisectRun UI → http://localhost:7331
```

直接按会话 id 指向 Claude Code 项目记录：

```bash
bisect-run ~/.claude/projects/-home-alice-myapp/abc123.jsonl \
           ~/.claude/projects/-home-alice-myapp/def456.jsonl --ui
```

### 无头模式输出

```text
────────────────────────────────────────────────────
BisectRun — first divergence
────────────────────────────────────────────────────
matched depth: 1 span(s)

FAILED divergence: Edit [2026-07-22T09:00:12.000Z] — src/math.ts
GOOD    divergence: Edit [2026-07-22T08:00:12.000Z] — src/math.ts

First divergence: same tool "Edit" but with different input —
  failed: Edit:src/math.ts|return a + b;
  good:   Edit:src/math.ts|return a - b;
```

---

## <img src="https://api.iconify.design/tabler/player-play.svg" width="26" align="top"> 演示

![BisectRun 演示](assets/demo.gif)

渲染这张 gif 的脚本位于 [`docs/demo.tape`](./docs/demo.tape)。

---

## <img src="https://api.iconify.design/tabler/bulb.svg" width="26" align="top"> 为什么

编码智能体具有不确定性。同一条 prompt 今天能跑通、明天就可能挂掉，而两者之间的差异很少是单行代码 —— 而是**一串**工具调用。靠肉眼在两份 500 步的记录里找它们在哪分叉，非常痛苦。

**BisectRun** 给这套流程起了名字、也给了一个按钮：

- **span 语义对齐** —— 当两次 span 调用相同工具且意图相同时（基于 tool_use 输入的稳定指纹），即视为匹配，而非逐字节相同。空白、uuid、时间戳都会被忽略，因此"同一步"在不同运行间仍能匹配。
- **首次分歧** —— 相当于 `git bisect` 的"首个坏 commit"，但粒度细化到 Agent 的一步。这一个 span 几乎总是最值得盯的那一处。
- **签名校验** —— 先比较运行签名（cwd + git 分支 + prompt），避免你误把两个不相关的任务拿来 bisect。
- **并排 UI** —— 两棵 span 树相邻渲染，分歧处高亮，让人一眼看到分叉。

BisectRun 是 **编码智能体** 缺失的那一层可观测性：把"Agent 退化了"变成"Agent 在**这一个** span 退化了"。

---

## <img src="https://api.iconify.design/tabler/layout-grid.svg" width="26" align="top"> 工作原理

1. **解析** —— 读取 Claude Code 的 `.jsonl` 记录，把每个 `tool_use` 与其对应的 `tool_result` 合并为一个 `Span`，并通过记录的 `parentUuid`/`uuid` 链路织成一棵树。首条用户消息、`cwd`、`gitBranch` 组成运行签名。
2. **对齐** —— 将两棵 span 树展平为时间序，按索引逐个比较每种工具的指纹（`Bash` → 命令、`Edit` → 文件 + old_string 头部、`Read` → 路径 ……）。指纹首次不一致的索引即为分歧点。
3. **报告** —— 无头模式把分歧打印到 stdout；`--ui` 启动 Hono 页面，两棵树并排渲染并高亮分歧。

---

## <img src="https://api.iconify.design/tabler/package.svg" width="26" align="top"> 目录结构

```
src/
  types.ts          Span, RunSignature, AlignmentResult
  parse-jsonl.ts    记录 → span 树 + 签名
  align.ts          span 语义对齐 + 首次分歧
  cli.ts            `bisect-run` commander 入口
  server.ts         Hono 差异 UI
test/
  fixtures/         failed/good 会话 JSONL
  parse.test.ts     align.test.ts
assets/             动态 hero + 架构图 SVG（明/暗）
docs/demo.tape      渲染演示 gif 的 vhs 脚本
```

## <img src="https://api.iconify.design/tabler/checkbox.svg" width="26" align="top"> 测试

```bash
npm test        # node:test, 10 个用例
npm run typecheck
npm run build   # tsc → dist/
```

---

## <img src="https://api.iconify.design/tabler/roadmap.svg" width="26" align="top"> 路线图

- [ ] 无需手填路径，按 `(cwd, sessionId)` 自动定位记录
- [ ] 针对并行 / 分支工具调用的子树对齐
- [ ] 用 LLM 对分歧 span 的输入做语义差异
- [ ] 接入 CI：把 PR 的 Agent 运行与 `main` 做 bisect，回归即失败
- [ ] 把分歧导出为可分享、可回放的链接
- [ ] 支持非 Claude Code 的记录格式

---

## <img src="https://api.iconify.design/tabler/license.svg" width="26" align="top"> 许可证

MIT © 2026 SuperMarioYL
