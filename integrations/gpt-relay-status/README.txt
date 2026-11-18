GPT 官号中转：图片排队状态小补丁

用途
旧版中转把排队和实际执行都返回 processing，工作台无法区分等待槽位与真正出图。
本补丁只在已验证版本 images.mjs 的 pollImage 内增加：
  pending → status: pending、stage: queued
  执行中 → status: processing、stage: generating
  合法的 createdAt / startedAt / finishedAt 时间
不改变提示词、账号选择、并发槽位、结果文件或其他生成流程。

先手动停止服务，备份操作会由补丁完成。不要删除旧服务文件夹，也不要删除 data。

PowerShell 使用示例（路径按实际修改）

1. 只检查，不写入：
   node "D:\更新包\integrations\gpt-relay-status\apply-relay-status.mjs" --service-root "D:\我的 即梦 GPT 服务" --check

2. 已手动停止统一服务后，执行补丁：
   node "D:\更新包\integrations\gpt-relay-status\apply-relay-status.mjs" --service-root "D:\我的 即梦 GPT 服务" --service-stopped

电脑没有全局 node 时，可使用服务包自带的 Node：
   & "D:\我的 即梦 GPT 服务\runtime\node\node.exe" "D:\更新包\integrations\gpt-relay-status\apply-relay-status.mjs" --service-root "D:\我的 即梦 GPT 服务" --service-stopped

支持两种目录结构：
  独立 GPT 中转：服务目录\images.mjs
  统一服务：    服务目录\engines\gpt\images.mjs
同时发现两套模块时拒绝修改，请指定准确目录。

输出结果
  ready：检查通过，尚未写入。
  patched：已更新。现在可以自行启动原服务。
  already-patched：已有同一补丁，没有再次写入。
  报错：未知模块结构、清单校验不符、符号链接等情况不会强行覆盖。

安全与回退
原文件保存在“指定服务目录\data\updates\gpt-image-status-时间-编号”中，receipt.json 列出原路径、备份文件名与校验值。
需要回退时保持服务停止，按 receipt.json 把对应 .original 文件复制回记录的相对路径，模块和被更新的清单一起恢复。
补丁只读取 images.mjs 及对应 MANIFEST.json / package-manifest.json，仅更新相关 files 条目的 bytes / sha256。
若外层清单记录了被更新的内层清单，会同步更新对应校验项；原始来源证明、其他清单字段保持原值。
不扫描服务目录，不读取、迁移、删除账号、API Key、Cookie 或数据库；不会自动停启服务，不修改网络配置。
没有发布清单的源码目录可以更新；存在清单但无法校验的目录必须人工核对。
