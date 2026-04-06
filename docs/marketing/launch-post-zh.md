# 中文首发帖

## 长版

我做了一个开源项目，叫 **Codex Harness Foundry**。

它想解决的不是“AI 会不会写代码”，而是另一个更实际的问题：

当项目从一次性需求变成一个要持续推进几天、几周的真实工程时，很多 AI coding workflow 会开始失控。

常见问题是：

- 关键上下文留在聊天里，不在仓库里
- 任务推进靠记忆，不靠结构化状态
- 角色边界不清晰，planner / builder / reviewer 混在一起
- 验证是可选项，所以“完成了没有”很难说清

**Codex Harness Foundry** 是一个 repo-native 的 Codex 工作台，核心思路是把这些状态沉淀进仓库：

- 项目身份配置
- `AGENTS.md` 指令上下文
- milestone 规划
- task board 状态
- verify 流程

它不是一个泛化的 autonomous agent 平台，也不是托管服务。
它更像一个开源模板，让 Codex 更像“小型产品团队”一样推进项目。

最短上手路径是：

```text
pnpm init:project
pnpm verify
pnpm planner:next
```

也就是说，你可以从一个模板仓库开始，把项目身份写入 repo，生成 repo-aware 的上下文，跑一遍验证，然后直接得到“下一步最该做什么”。

我觉得它适合这些人：

- 想让 Codex 持续推进中长期项目的人
- 需要 planner / builder / verifier 分工的人
- 想把 AI 工作流沉淀进仓库的人

不太适合这些场景：

- 只想做一次性 prompt coding
- 不想维护 repo-level workflow
- 项目本身没有稳定验证路径

如果你也在用 Codex 做真实项目，欢迎看看：

仓库：
https://github.com/dawid0309/Codex-Harness-Foundry

模板入口：
https://github.com/dawid0309/Codex-Harness-Foundry/generate

如果你愿意，也很欢迎直接告诉我：

1. 你现在的 AI coding workflow 最大痛点是什么
2. 你觉得 planner / builder / verifier 这种分工有没有意义
3. 这套 repo-native 方式还缺哪一块

## 短版

做了个开源项目：**Codex Harness Foundry**

不是让 AI “多写点代码”，而是让 Codex 在中长期项目里，尽量别把状态全留在聊天里。

核心是把这些沉淀进 repo：

- context
- milestone
- task board
- verify workflow

最短流程：

```text
pnpm init:project
pnpm verify
pnpm planner:next
```

适合想让 Codex 持续推进项目的人。

Repo:
https://github.com/dawid0309/Codex-Harness-Foundry
