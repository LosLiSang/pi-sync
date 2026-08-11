# ADR-0004: 合并与报告基于 include 投影快照；删除是快照层面的

远端/历史快照可能携带 include 声明之外的残留路径（旧 include 同步过、或另一台机器还在用旧 include），而本地快照永远是 include 的投影（`createSnapshot` 只扫 include）。此前合并引擎（`planMerge`/`mergeSnapshot`）对 include 外路径照常参与三路合并：残留被算成 takeRemote/conflict，写回时又被 `resolveSnapshotTarget` 静默丢弃——引擎做无用功，merged 快照携带"不存在于磁盘"的条目，status 持续显示 removed 噪声。决定：**合并（三路 planMerge）与差异报告（fetch/status）使用前，把 local/remote/base 三方快照全部投影到 include 覆盖集**——快照投影是合并与报告的唯一事实来源，include 外残留不参与合并、不进入 merged 快照、不产生报告噪声；`resolveSnapshotTarget` 的跳过逻辑保留为防御性安全网（防止未来调用方绕过投影）。

**删除语义**：删除是快照层面的——文件从快照移除（停止同步、push 后净化远端），**本地磁盘文件永不物理删除**（`applySnapshot`/`writeAgentContent` 只写不删）。「删除 vs 未同步」由 base（上次应用的远端提交，`state.lastRemoteRevision`）判定：base 有则缺失=删除，base 无则缺失=未同步；单向变化自动采纳（takeLocal/takeRemote），双向变化报 conflict。无 base（新机器/state 丢失/远端 force push 后）时对「两边都有且不同」的文件保守报冲突，绝不自动删/覆盖。

**Considered Options**：合并前过滤 vs 维持现状靠 push 自愈（残留噪声与无用功）vs 视为远端删除主动清理（动远端历史，过度）；只投影 remote vs 三方投影（三方一致，删除判定清晰）；报告投影与否（投影后残留隐身，不投影则每次 fetch 提示 removed 直到 push）。

**Consequences**：include 缩小只停止同步，本地文件保留；pull 后 merged 快照与 `createSnapshot` 一致，状态立即 up-to-date；include 外残留随下一次 push 净化；新机器首次 pull 对内容不同的文件保守报冲突。
