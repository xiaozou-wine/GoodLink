# GoodLink 百度直链助手

油猴脚本，从百度网盘分享页获取直链下载地址，支持多账号并行获取。

## 功能

- **分享页直链获取** — 打开分享链接自动提取文件，小文件直接拿 dlink，大文件保存到网盘后获取
- **多账号轮询** — 支持添加多个百度 OAuth token，依次尝试，叠加带宽
- **BDUSS + OAuth 双认证** — OAuth 获取直链，BDUSS 负责保存到网盘，互不依赖
- **清理网盘** — 下载完成后一键删除网盘中临时保存的文件

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 Tampermonkey 面板 → 新建脚本
3. 把 `userscripts/goodlink-helper.user.js` 的内容粘贴进去保存
4. 访问 `pan.baidu.com` 确认脚本已加载

## 使用

### 添加账号

1. 在百度网盘页面右下角打开 GoodLink 面板
2. 点击「添加账号」，复制 OAuth 授权链接
3. 在新标签页打开链接，登录百度并授权（注意切换到你要用的百度账号）
4. 授权后脚本自动捕获 token，也可以手动粘贴
5. 可选：填入 BDUSS cookie（用于大文件保存到网盘）

### 获取直链

1. 打开百度网盘分享链接
2. GoodLink 面板自动显示文件列表
3. 点击「获取直链」，脚本会依次用每个 token 尝试
4. 成功后复制直链到下载器（Motrix、IDM 等）

### 大文件处理

分享页的 sharedownload API 对大文件不返回 dlink，脚本自动走以下路径：

1. 尝试客户端协议（Pan API download）
2. 保存到个人网盘 → OAuth file.list 查找正确的 fs_id → filemetas 获取 dlink
3. 下载完后可点「清理网盘」删除临时文件

## 技术细节

- OAuth 授权 scope: `basic,netdisk`，client_id 脚本内置
- filemetas API 只接受 OAuth access_token，不支持 BDUSS
- share/transfer 返回的 fs_id 是分享源文件的，不是个人网盘里的，需要重新查 file.list
- 所有 OAuth API 调用使用 `anonymous` 模式，避免浏览器 BDUSS cookie 干扰

## 参考

- `userscripts/baidu-api-reference.md` — 百度网盘 API 端点速查
- [LinkSwift](https://github.com/AdlerED/GIDOWN) — 原始参考项目
