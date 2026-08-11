# ADR-0002: automatic 只观察不写，删除后台自动同步

初版重写的旗舰功能是后台自动同步：会话启动时自动 fetch 并**自动决定 push/pull/merge**，关会话时自动 push。grilling 决定：git 式手动模型下任何自动写文件都不可接受。`automatic` 重定义为只控制"会话启动时 fetch（非破坏性观察）+ 刷新状态栏指示器"，永不自动应用改动；关会话的自动 push 彻底删除。

**Considered Options**：保留自动 push/pull/merge（首版行为，用户明确否定）；automatic 只 fetch（选定——观察成本低、写路径全手动）。

**Consequences**：跨机器收敛只能靠手动 pull/push 或显式命令；状态栏指示器成为唯一的被动提醒；`automatic: false` 时连启动 fetch 都关闭，完全手动。
