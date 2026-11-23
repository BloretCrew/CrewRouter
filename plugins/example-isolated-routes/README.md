# 隔离 JSON Route 示例

仅支持 manifest 中声明的静态精确路径和 `user`/`admin` 认证；公开 `auth:none` 路由不允许。worker 收到 JSON `method/path/body/query/authRole`，不含 Cookie、headers、session、用户/Key 标识或 Express 对象；返回 `{ status?, body: JSON object }`。

Linux 需要显式启用 bwrap isolated-task runtime。body/query 与结果合计受 RPC 64 KiB 限制；不提供 storage、network、数据库、headers 修改或通用 host API。
