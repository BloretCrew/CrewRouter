# 管理后台统一模型库

管理后台使用「模型库」统一访问供应商、系统模型与 TEAM 管理。浏览路由为 `/admin#adminModelLibrary`，具体 TEAM 为 `/admin#adminModelLibrary/team/<id>`。

## 操作范围

管理后台以用户控制台模型库为视觉基准，复制其页面区块、供应商折叠分组和模型条目结构，复用 `model-library-blora.css` 与 Blora 控件。后台视图模板集中在 `public/js/admin-library-console-view.js`；用户控制台本身不变。用户侧 Key 绑定、星标与隐藏操作替换为后台的系统启停、TEAM 授权、批量选择及完整管理入口，数据和写入仍使用管理员接口。

视觉直接沿用控制台的 Blora 按钮、搜索、下拉、徽章及更多菜单，不再用后台自定义按钮和卡片皮肤覆盖。顶部保留供应商管理、添加供应商和更多菜单；模型卡片只常驻编辑/系统启用，其余管理能力收进同款下拉。TEAM 范围独立成条，搜索、供应商、排序、更多筛选和结果数位于同一工具栏；已选筛选以可单独移除的标签展示。批量工具在勾选模型后出现，全选已加载与按筛选批量操作收进“批量操作”菜单。供应商额度移到模型目录之后并支持折叠，避免额度卡片挤占首屏。供应商分组头展示格式、标签、模型数、授权/启用数量和额度摘要；模型卡展示上游 ID、状态、测试结果、系列及价格。筛选通过 `blora-select` 的 `change` 事件处理，菜单动作使用结构化值分发，不执行内联脚本。

模型库内的编辑、同步、测试和额度操作直接执行，只有“供应商管理 / 模型管理 / TEAM 管理”打开管理面板。从模型库新增或编辑供应商后，保存成功会刷新当前模型库；控制台内嵌的“我的上游”继续直接展示供应商管理页。

- 「全部模型」中的开关控制系统模型启用状态，影响全部用户。
- 选择 TEAM 后，开关控制该 TEAM 的模型授权。供应商及系统模型状态另行展示。
- 关闭模型授权可能清理失去访问权限的 API Key 绑定；恢复授权后需要重新配置已清理的绑定。
- 模型复选框用于批量操作。筛选、分页与供应商展开加载减少大目录的前端开销。

## 供应商编辑器

供应商编辑器在桌面使用左侧分区导航和右侧表单的双栏布局，面板约 1100px 宽、860px 高；宽度不超过 900px 时改为全屏，分区导航横排滚动。

七个分区保持为基本信息、密钥、模型与额度、代理、测试配置、请求头转发和标签。API Key 列表、顺序/权重策略与脚本刷新统一放在“密钥”分区；基本信息只保留名称、Base URL、格式、启用状态和备注。额度关闭时隐藏查询方式及条件配置，脚本模式下隐藏顺序/权重选择。

保存前统一校验名称、Base URL、模型列表 URL、脚本、CPA、火山方舟和代理配置。失败时显示错误摘要，跳到第一个错误分区并标记、聚焦字段。关闭、Esc 或点击遮罩时若有未保存修改会要求确认；保存过程中禁止重复提交和关闭。保存成功后按来源返回模型库或刷新管理面板。

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
node scripts/test-admin-library-console-view-browser.js
node scripts/test-provider-editor-pages-browser.js
node server/scripts/test-provider-manager-permissions.js
node server/scripts/test-personal-model-access.js
node server/scripts/test-frontier-auto-add.js
node server/scripts/test-instance-edition.js
node server/scripts/test-instance-edition-persistence.js
```

浏览器测试使用隔离的内存数据及模拟上游，不操作生产数据库或调用真实供应商。推送、部署、生产服务重启和真实上游验证需要另行授权。
