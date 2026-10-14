# 管理后台统一模型库

管理后台使用「模型库」统一访问供应商、系统模型与 TEAM 管理。浏览路由为 `/admin#adminModelLibrary`，具体 TEAM 为 `/admin#adminModelLibrary/team/<id>`。

## 操作范围

- 「全部模型」中的开关控制系统模型启用状态，影响全部用户。
- 选择 TEAM 后，开关控制该 TEAM 的模型授权。供应商及系统模型状态另行展示。
- 关闭模型授权可能清理失去访问权限的 API Key 绑定；恢复授权后需要重新配置已清理的绑定。
- 模型复选框用于批量操作。筛选、分页与供应商展开加载减少大目录的前端开销。

## 管理功能

供应商编辑、同步、额度与脚本、多密钥、代理、请求头及高级配置从分组快捷操作和统一管理面板访问。模型编辑、测试、定价、速率限制、系列、归因、在线状态、导出及其他批量工具继续复用既有完整管理器。

TEAM 管理面板提供 TEAM 创建与编辑、成员、默认/前沿 TEAM、额度可见性及请求/Token 限额规则。个人账户 TEAM 保留保护限制。

旧链接 `#adminProviders`、`#adminModels` 和 `#adminTeams` 打开统一模型库中的对应管理面板；`#adminTeams/<id>` 直接进入该 TEAM 的模型授权视图。

Personal 和 Desktop Local 使用供应商及系统模型管理能力；TEAM 选择及管理按实例能力隐藏，服务端继续校验版本和权限。控制台的内嵌供应商管理保持兼容。

## 兼容与安全

- TEAM 授权写入、成员 Key 绑定清理使用同一事务，提交成功后失效权限缓存。
- 关闭授权覆盖普通模型队列、Harness 单独绑定及融合模型配置；其他有效 TEAM 授权仍可保留绑定。
- 系统批量开关提交后释放事务连接，再执行前沿 TEAM 自动授权。模型更新采用兼容外键校验的行锁，避免与 TEAM 首次授权形成锁等待环。
- 全部模型模式保留管理员管理用户供应商的能力，具体 TEAM 授权仅使用系统供应商模型。
- 英文/中文切换保留当前 TEAM、筛选、分页及选择状态。供应商额度默认读取已存储历史观测，手动刷新使用既有额度查询流程。

## 验证

```sh
node server/scripts/test-admin-model-library.js
node --test scripts/test-admin-library-team-rules.js scripts/test-admin-model-library-ui.js scripts/test-admin-library-integration.js
node scripts/test-admin-model-library-browser.js
node server/scripts/test-provider-manager-permissions.js
node server/scripts/test-personal-model-access.js
node server/scripts/test-frontier-auto-add.js
node server/scripts/test-instance-edition.js
node server/scripts/test-instance-edition-persistence.js
```

浏览器测试使用隔离的内存数据及模拟上游，不操作生产数据库或调用真实供应商。推送、部署、生产服务重启和真实上游验证需要另行授权。
