这个文档是针对你提供的 `server.js` 中关于 `/SF/` 路径及其相关功能的接口说明。
服务器地址：https://img.bloret.net/

---

# SF 图标服务 API 文档

该 API 允许用户从服务器的 `SFs` 目录获取 SVG 图标，并支持动态修改颜色以及将格式转换为 PNG。

## 1. 获取图标 (主接口)

通过文件名获取指定的图标。

- **URL:** `/SF/:name`
- **方法:** `GET`
- **路径参数:**
    - `name` (必选): 图标的文件名（如 `home`, `user.svg`）。如果省略 `.svg` 后缀，系统会自动补全。
- **查询参数:**
    - `color` (可选): 指定图标的颜色。支持颜色名称（如 `red`）或十六进制（如 `%23ff0000`，注意 `#` 需转义）。默认值为 `black`。
    - `png` (可选): 布尔值。如果设为 `true`，则返回 PNG 格式的图片，否则返回 SVG 格式。
- **功能描述:**
    - 系统会读取 `SFs/` 目录下的相应 SVG 文件。
    - 自动替换 SVG 源码中所有 `fill="..."` 或 `stroke="..."` 的属性值为指定的 `color`。
    - 若请求了 `png=true`，则利用 `sharp` 库进行服务端渲染转换。

### 示例请求

**获取默认黑色 SVG:**
`GET /SF/heart`

**获取红色 SVG:**
`GET /SF/heart?color=red`

**获取蓝色 PNG 图片:**
`GET /SF/star?color=blue&png=true`

### 响应说明
- **成功 (SVG):** 返回 `Content-Type: image/svg+xml`。
- **成功 (PNG):** 返回 `Content-Type: image/png`。
- **错误 (404):** `Icon not found` - 文件不存在。
- **错误 (500):** `Error processing icon` - 图片处理或转换失败。

---

## 2. 获取所有图标列表

获取服务器上所有可用的 SVG 文件名清单。

- **URL:** `/api/svg_files`
- **方法:** `GET`
- **响应格式:** JSON 数组
- **示例响应:**
  ```json
  ["home.svg", "settings.svg", "user.svg"]
  ```

---

## 3. 技术细节说明

### 颜色替换逻辑
服务器使用正则表达式进行简单替换：
```javascript
const coloredSvg = svgString.replace(/(fill|stroke)="[^"]*"/g, `$1="${color}"`);
```
*注意：这会替换 SVG 中所有的填充和描边属性。如果原始 SVG 内部没有 `fill` 或 `stroke` 属性，则颜色更改可能无效。*

### 目录结构要求
为了使 API 正常工作，服务器根目录下必须存在 `SFs/` 文件夹，并存放 `.svg` 文件。

### 依赖环境
- **Express**: 路由处理。
- **Sharp**: PNG 转换的核心库（必须安装：`npm install sharp`）。
- **fs/path**: 文件系统操作。

---

## 4. 辅助页面 (前端)

- **图标浏览器:** 直接访问 `/SF` (对应 `public/SF.html`)。
- **主页:** 访问 `/` (对应 `public/index.html`)。
- **文档页:** 访问 `/api/doc` (对应 `public/doc.html`)。
