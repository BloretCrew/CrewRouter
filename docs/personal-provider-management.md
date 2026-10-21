# Local 与 Personal 供应商管理

Local / Personal 控制台的“供应商管理”复用完整管理界面，显示实例内全部供应商。历史 `created_by` 保留，用户界面不按系统/个人分组，不展示范围筛选。

完整管理支持已有供应商编辑器功能：多密钥及选择策略、模型同步、额度与查询脚本、代理、请求头、标签和模型配置。供应商编辑器在桌面使用分区侧栏和表单双栏，小屏为全屏；保存前校验并定位错误，关闭未保存表单时要求确认。目录加载失败时可重试或直接手动添加。

权限只扩大到供应商及模型相关 API。服务器验证当前数据库用户存在和实例版本，持久化 Team 版本优先；Team 普通用户继续受供应商 ownership 限制，完整管理要求管理员。不会授予普通个人用户团队、系统设置或用户管理权限。

新增/启用/同步模型后，Personal 实例为已有有效个人 Team 幂等补齐启用模型关联。已有禁用映射保持不变；Team 前沿模型关联逻辑保持原有行为。数据库没有自动删除或迁移供应商归属。

控制台通过同源内嵌管理视图直接展示供应商管理页，隐藏重复侧栏和页头；不再额外套一层模型库管理抽屉。系统管理页面仍可独立打开。修改后请重新部署服务器及网页资源；Desktop 本地模式需要同步内置服务包。

验证：

```sh
node server/scripts/test-provider-manager-permissions.js
node server/scripts/test-personal-model-access.js
node server/scripts/test-frontier-auto-add.js
node scripts/test-unified-provider-browser.js
```
