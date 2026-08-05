---
name: cookie-exporter
description: "导出本地浏览器 cookie 为 Netscape 格式 cookies.txt，供 yt-dlp 等工具下载需要登录的视频时使用。支持 Chrome、Edge、Brave、Firefox。当用户需要下载需要登录的网页视频、遇到 yt-dlp 报错需要 cookie、或想批量导出浏览器登录态时使用。"
---

# Cookie 导出助手

## 用途

将本地浏览器的 cookie 导出为 Netscape 格式的 `cookies.txt` 文件，供 yt-dlp、wget、curl 等工具在下载需要登录态的资源时使用。

这个 skill **完全独立**，不依赖任何网关或外部服务，只需要 Python 3.8+ 和 pycryptodome（Chrome 解密用，Firefox 不需要）。

## 工作流程

1. 探测用户系统已安装的浏览器。
2. 让用户选择要导出的浏览器（Chrome / Edge / Brave / Firefox）。
3. 列出该浏览器中的 cookie 域名，让用户选择目标域名，或选择导出全部。
4. 调用 `scripts/export_cookies.py` 执行导出。
5. 返回 `cookies.txt` 文件路径，并给出使用建议。

## 依赖检查

调用脚本前先检查 Python 环境：

```bash
python --version || python3 --version
```

如果 Python 不可用，不要继续。提示用户安装 Python 3：
- Windows：Microsoft Store 或 python.org，或 `winget install Python.Python.3`
- macOS：python.org 或 `brew install python`
- Linux：`sudo apt install python3` / `sudo dnf install python3` / `sudo pacman -S python`

Chrome 类浏览器（Chrome / Edge / Brave）还需要 pycryptodome：

```bash
pip install pycryptodome || pip3 install pycryptodome || uv tool install pycryptodome
```

Firefox 无需额外依赖。

## 脚本用法

```bash
# 列出已安装浏览器
python scripts/export_cookies.py --list-browsers

# 列出某浏览器的 cookie 域名
python scripts/export_cookies.py --browser chrome --list-domains

# 导出指定域名的 cookie
python scripts/export_cookies.py --browser chrome --domain youtube.com -o cookies.txt

# 导出全部 cookie
python scripts/export_cookies.py --browser firefox --all -o cookies.txt
```

## 跨平台说明

| 平台 | Chrome/Edge/Brave 密钥来源 | Firefox |
|------|--------------------------|---------|
| macOS | Keychain（会弹窗要求授权） | 明文读取 |
| Windows | DPAPI（当前用户上下文） | 明文读取 |
| Linux | gnome-keyring / kwallet，或 fallback "peanuts" | 明文读取 |

macOS 上首次运行可能弹出 Keychain 授权弹窗，这是正常的，用户点击"始终允许"即可。

## 安全说明

- 只读本地浏览器文件，不访问网络，不会触发网站封号。
- 解密密钥仅在内存中使用，不落盘、不记录日志。
- 导出的 cookies.txt 文件权限为 0600（仅当前用户可读）。
- cookie 中包含登录凭证，提醒用户不要将 cookies.txt 分享给他人。
