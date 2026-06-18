# GoodLink 百度直链助手

百度网盘直链获取工具集，包含油猴脚本和 Chrome 扩展。

## 项目结构

```
GoodLink/
├── userscripts/
│   └── goodlink-helper.user.js    # 油猴脚本 — 分享页直链获取
├── baidu-token-grabber/           # Chrome 扩展 — Token + BDUSS 抓取
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   └── popup.js
└── release/
    └── GoodLink-Token-Grabber-v1.0.0.zip  # 扩展打包
```

---

## 一、GoodLink Token 抓取器（Chrome 扩展）

一键抓取百度网盘的 OAuth access_token 和 BDUSS cookie，供油猴脚本使用。

### 安装

1. 下载 `release/GoodLink-Token-Grabber-v1.0.0.zip` 并解压
2. 打开 Chrome，地址栏输入 `chrome://extensions`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的 `baidu-token-grabber` 文件夹
5. **重要**：点击扩展的「详细信息」→ 开启 **允许在无痕模式下运行**

### 使用

1. 点击浏览器工具栏上的 GoodLink Token 抓取器图标
2. （可选）修改导出文件夹名称，默认为 `GoodLink_tokens`
3. 点击 **开始抓取**
4. 自动打开无痕窗口，进入百度网盘页面
5. 在页面上 **登录**（支持密码登录和扫码登录）
6. 登录成功后自动跳转到 OAuth 授权页
7. 自动捕获 Token + BDUSS → 导出 JSON 文件 → 关闭无痕窗口
8. 如果自动跳转没有触发，点击弹窗中的 **手动跳转 OAuth** 按钮

### 导出文件

文件保存在浏览器下载目录下的 `GoodLink_tokens/` 文件夹，文件名格式：`百度账号1_20260618.json`

```json
{
  "account_name": "百度账号1_20260618",
  "baidu_username": "你的用户名",
  "access_token": "xxx",
  "expires_in": "2592000",
  "scope": "basic,netdisk",
  "bduss": "xxx",
  "captured_at": "2026-06-18T12:00:00.000Z"
}
```

- `access_token` — OAuth 令牌，用于获取直链
- `bduss` — httpOnly Cookie，用于保存大文件到网盘
- 有效期约 30 天，过期后重新抓取

### 抓取多个账号

每次点「开始抓取」会打开新的无痕窗口，登录不同的百度账号即可。所有账号记录保存在扩展的弹窗历史中，导出文件名自动递增（百度账号1、百度账号2...）。

---

## 二、GoodLink 百度直链助手（油猴脚本）

从百度网盘分享页获取直链下载地址，支持多账号轮询、大文件处理。

### 安装

#### 第一步：安装油猴扩展

安装以下任一油猴管理扩展（推荐 Tampermonkey）：

| 浏览器 | 扩展 |
|--------|------|
| Chrome / Edge | [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) |
| Safari | [Tampermonkey](https://apps.apple.com/app/tampermonkey/id1482490089) |

#### 第二步：安装脚本

从 [Releases](https://github.com/xiaozou-wine/GoodLink/releases) 下载 `goodlink-helper.user.js`，双击打开，浏览器会自动弹出 Tampermonkey 安装确认页面，点击安装即可。

### 添加账号

脚本需要 OAuth access_token 才能获取直链。有两种方式获取：

**方式一：用 Chrome 扩展自动抓取（推荐）**

使用上面的 GoodLink Token 抓取器，自动获取 access_token + BDUSS。

**方式二：手动 OAuth 授权**

1. 在百度网盘页面右下角点击 GoodLink 面板按钮
2. 点击「添加账号」→ 复制 OAuth 授权链接
3. 在新标签页打开链接，登录百度账号并授权
4. 授权后页面显示 access_token，脚本自动捕获
5. 可选：填入 BDUSS（用于大文件保存到网盘）

### 获取直链

1. 打开任意百度网盘 **分享链接**（如 `pan.baidu.com/s/xxx`）
2. GoodLink 面板自动显示文件列表
3. 选择文件，点击 **获取直链**
4. 脚本依次用每个 token 尝试获取 dlink
5. 成功后复制直链到下载器

### 大文件处理

分享页的 sharedownload API 对超过约 50MB 的文件不返回 dlink，脚本自动走以下路径：

1. 保存到个人网盘 → OAuth search 搜索文件 → filemetas 获取 dlink
2. 下载完后可点「清理网盘」删除临时文件

### 新版功能（v1.1.0）

- **多选账号** — 勾选要使用的账号，一键批量获取直链
- **健康检测** — 一键检测所有账号状态（OAuth + BDUSS + 封禁）
- **Web 管理面板** — 直链管理、账号管理、日志三个 tab
- **直链缓存** — 获取过的直链持久化保存，支持从网盘删除文件
- **BDUSS 检测** — 自动检测 BDUSS 是否有效/匹配

### 配合下载器

获取直链后推荐使用 [Motrix Next](https://github.com/xiaozou-wine/motrix-next) 下载，支持多源并行。

**多源下载原理**：多个百度账号各拿到同一文件的直链，用下载器同时分段下载，叠加带宽。

---

## 常见问题

**Q: 脚本/扩展安全吗？**
所有操作在本地浏览器完成，Token 和 Cookie 不会发送到第三方服务器，仅与百度 API 通信。

**Q: access_token 过期了怎么办？**
重新用 Token 抓取器抓取，或在 GoodLink 面板重新 OAuth 授权。

**Q: 扩展在无痕模式下不工作？**
确保在 `chrome://extensions` → 详细信息中开启了「允许在无痕模式下运行」。

**Q: 直链获取失败 errno=-20？**
百度反爬虫机制，稍等几分钟重试，或换一个 token 尝试。

## 技术参考

- `userscripts/baidu-api-reference.md` — 百度网盘 API 端点速查
- [LinkSwift](https://github.com/AdlerED/GIDOWN) — 原始参考项目
- [BaiduPCS-Go](https://github.com/qjfoidnh/BaiduPCS-Go) — 客户端协议参考
