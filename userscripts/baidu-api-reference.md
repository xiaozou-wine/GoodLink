# GoodLink 百度网盘 API 参考

> 如果百度更换 API 导致脚本失效，对照此文档排查。

## 1. sharedownload（小文件直链）
- **端点**: `POST https://pan.baidu.com/api/sharedownload`
- **认证**: 无（靠 sign + timestamp + jsToken）
- **参数**: sign, timestamp, bdstoken, jsToken, sekey, fid_list (POST body)
- **响应**: errno=0 时 list 为数组（小文件含 dlink）或加密字符串（大文件）
- **注意**: errno=-20 表示反爬验证码触发

## 2. share/transfer（保存分享文件到网盘）
- **端点**: `POST https://pan.baidu.com/share/transfer?shareid=xxx&from=xxx&sekey=xxx`
- **认证**: BDUSS cookie（GM_xmlhttpRequest withCredentials）
- **参数**: fsidlist=[fs_id], path=/ (POST body, URL encoded)
- **响应**: errno=0 成功（info[0] 有 path 和 fsid）, errno=4 已存在, errno=2 参数错误
- **关键**: sekey 必须在 URL query 里，不在 body

## 3. file.list（个人网盘文件列表）
- **端点**: `GET https://pan.baidu.com/rest/2.0/xpan/file?method=list`
- **认证**: OAuth access_token（URL 参数）✅ / BDUSS cookie（从分享页调 errno=-6）❌
- **参数**: dir, order, desc, page, num, access_token
- **响应**: errno=0, list[] 含 path/server_filename/fs_id

## 4. filemetas（获取 dlink）
- **端点**: `GET https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1`
- **认证**: OAuth access_token（URL 参数）
- **参数**: fsids (JSON 数组), dlink=1, access_token
- **响应**: errno=0, list[].dlink 为下载链接
- **注意**: dlink 带 access_token 参数，下载时需要 `User-Agent: pan.baidu.com`

## 5. uinfo（账号信息）
- **端点**: `GET https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo`
- **认证**: OAuth access_token / BDUSS cookie
- **响应**: errno=0, uk, baidu_name, vip_type, used, total

## 6. gettemplatevariable（首页签名）
- **端点**: `GET https://pan.baidu.com/api/gettemplatevariable?fields=["sign1","sign3","timestamp"]`
- **认证**: 浏览器 cookie
- **响应**: result.sign1, result.sign3, result.timestamp
- **用途**: sign2 = RC4(sign3, sign1)，用于 Pan API download

## 7. xpan/share?method=transfer（OAuth 保存）
- **端点**: `POST https://pan.baidu.com/rest/2.0/xpan/share?method=transfer&access_token=xxx`
- **认证**: OAuth access_token
- **参数**: fsid_list=[xxx] (有下划线), path=/
- **响应**: errno=-6 无权限（OAuth token 无法保存分享文件）

## 8. locatedownload（PCS 下载，当前不可用）
- **端点**: `POST https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload`
- **认证**: BDUSS cookie + SHA1 签名（time/rand/devuid/cuid）
- **签名**: SHA1(SHA1(BDUSS) + uid + LOCATE_DOWNLOAD_SECRET + time + devuid)
- **密钥**: `ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF`
- **状态**: 签名算法与 BaiduPCS-Go 一致，但返回链接 sign error — 可能百度已更新

## 9. pan/api/download（首页签名下载）
- **端点**: `POST https://pan.baidu.com/api/download`
- **认证**: sign2 (RC4 sign) + timestamp
- **参数**: sign, timestamp, fidlist
- **状态**: errno=0 但不返回 dlink（对分享页 fs_id 无效，对个人网盘文件可能有效）

## 10. filemanager（删除文件）
- **端点**: `POST https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete`
- **认证**: OAuth access_token（URL 参数）
- **参数**: filelist (POST body, URL encoded JSON 数组: `["/path1","/path2"]`)
- **响应**: errno=0 成功, info 含删除结果
- **注意**: 删除后 dlink 立即失效，必须等下载完成后再删除

## Motrix RPC（已移除）
> 用户改为手动复制直链到下载器，Motrix 自动发送逻辑已删除

- **端点**: `http://127.0.0.1:29100/jsonrpc`
- **密钥**: `Qwcvbwkb6A0hfS1S`
- **方法**: aria2.addUri
- **Header**: `User-Agent: pan.baidu.com`
