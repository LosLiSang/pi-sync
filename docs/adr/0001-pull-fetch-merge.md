# ADR-0001: pull 默认语义为 fetch+merge，覆盖降级为 --force

重写后 `pull` 曾是"用远端快照覆盖本地"（相当于 git reset --hard）。用户认为这不符合 git 式预期：pull 应该把远端改动**合并**进本地。决定：`pull` = fetch + 三路合并，无冲突直接应用；冲突时 `--force` 才覆盖本地，`--merge` 进入交互式解决。`pull` 无 flag 遇冲突不写任何文件，只提示两条路径。

**Considered Options**：保留覆盖式 pull（简单但破坏性、不可预期）；删除 pull 只留 fetch/merge（多一步、不符合 git 直觉）。

**Consequences**：pull 变成安全命令——永不静默丢本地改动；`--force` 是唯一"丢弃本地"的入口。
