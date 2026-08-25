# ADR-0005: 放弃单文件快照，改用 mirror 工作区存真实文件树

## 背景

初版把 `~/.pi/agent` 下所有 include 内容用 base64 塞进**一个** `pi-sync/snapshot.json` 作为唯一传输/存储单元。这一选择带来两个无法绕开的问题：

1. **冲突检测有 bug**：git 眼里只有一个 blob，无法按路径/按行检测差异。因此手搓了 `planMerge`（按 sha256 逐文件比对），且**自己维护 base**——base 不是 git 的 merge-base，而是本地 `state.json` 里的 `lastRemoteRevision`。结果是"无 base（新机器 / state 丢失 / 远端 force push）→ 两边不同就保守报 conflict"，**换台新机器首次 pull 会被误判成冲突**。

2. **merge 难以实现**：因为不是真实文件树，git 原生三路合并、行级 diff3、按路径冲突标记全用不上。只能在 `mergeTexts` 里再手搓一遍 JSON field-wise + `git merge-file --diff3` 兜底。所有复杂度都是为了绕开"不是真实文件"这个约束。

## 决策

放弃"单文件快照"，让 mirror git 仓库直接持有**真实文件树**：

- mirror 仓库 checkout 到配置的同步分支，工作树里就是真实的 include 文件（`settings.json`、`skills/…`、`prompts/…`）。
- **冲突检测**交给 git 原生（按路径 + 行，merge-base 自动计算）——新机器、state 丢失、远端 rewrite 都不再误报，因为 base 是真共同祖先。
- **合并**交给 git 原生三路合并（`git merge`），冲突标记落在真实文件上。
- **删除语义** = git 树里文件删除即删除，snapshot projection / 快照删除那套机制整体删除。
- **去掉 in-UI 结构化解析**：冲突标记写入真实文件，由用户用外部编辑器解决，再 `/sync merge` 确认或 `/sync pull --force` 覆盖。`conflict` / `resolve` / `merge-session` 模块删除。

不在同步分支里的文件（include 之外的残留）随本地投影自然不在树中，无需投影逻辑。

## 命令语义

- `push`：把 agentDir 的 include 内容同步进 mirror 工作树（staging），`git add` + `commit` + `push`。远端已前进则拒绝，除非 `--force`。
- `pull`：`git fetch` → 把 agentDir 同步进 mirror 工作树并 commit（作为"本地侧"）→ `git merge origin/<branch>` 做真实三路 → 结果写回 agentDir。冲突则带标记写回并提示 `/sync merge`。
- `merge`：确认 `git merge` 的冲突已解决并落盘/写回 agentDir；`--abort` 放弃合并恢复。
- 状态栏 / `status --diff`：基于 mirror 工作树与 `origin/<branch>` 的真实 diff（git 原生 `git status` / `git diff`）。

## 状态文件

`state.json` 整体删除——git 历史即状态，base 由 merge-base 计算，不再需要 `lastRemoteRevision` 锚点。

## 影响

删：`snapshot.ts`（base64 打包）、`merge.ts`（手搓合并）、`conflict.ts`、`resolve.ts`、`merge-session.ts`、`state.ts`。
改：`git.ts`（真实文件树后端）、`operations.ts`（命令重写）、`status.ts`、`diff.ts`。
留：`config.ts`、`paths.ts`、`wizard.ts`、`config-ui.ts`、`extension.ts`（命令面不变）。
