即梦9张参考图提交补丁（2026-11-16）

原因：前端和即梦适配器已支持9张，但后台 POST /tasks 的入口仍硬编码8张。
补丁只修改 backend/src/routes/tasks.ts 的这一处判断，并引用既有 JIMENG_IMAGE_LIMIT=9。
不覆盖整个项目，不修改账号、Key、Cookie、任务、图片、Skill或提示词。

服务器应用步骤：
1. 正常停止火宝后台。不要停止一体平台，也不要删除data。
2. 解压此补丁到任意目录。
3. 双击 Apply-Fix.cmd，输入服务器上的火宝程序根目录，例如：
   D:\项目\huobao-source-20261107-platform
   （应能在该目录看到 backend、frontend、scripts、data。）
4. 看到 ok:true 后，正常启动火宝，浏览器按 Ctrl+F5。
5. 用9张参考图手动提交；不需要重新生成资产。

补丁会先核对适配器已经支持9张、旧判断恰好存在一次，并检查程序已停止；
原文件自动备份到 data/update-backups/jimeng-nine-时间/tasks.ts。
如果提示源码不同，请保留提示，不要强行覆盖整个 tasks.ts。

验证：公开任务接口9张成功到达模拟即梦服务；第9张名称、原始PNG字节、SHA256、image_9绑定完整。
10张在创建本地任务和外部请求前明确拒绝。未调用真实即梦、未消耗积分。
前端7项、后端即梦19项专项通过，TypeScript检查通过。
