#!/usr/bin/env python3
"""
Cookie Exporter - 导出本地浏览器 cookie 为 Netscape 格式 cookies.txt

支持浏览器: Chrome, Edge, Brave, Firefox
跨平台: macOS (Keychain), Windows (DPAPI), Linux (keyring/fallback)

这是离线备用路径。若本项目网关可用，优先使用浏览器扩展
「Leo cookie.txt Locally」导出（可在 Chrome 开启时工作，并绕过 Windows 文件锁与 app-bound encryption）。

用法:
    python export_cookies.py --list-browsers
    python export_cookies.py --browser chrome --list-domains
    python export_cookies.py --browser chrome --domain youtube.com -o cookies.txt
    python export_cookies.py --browser firefox --all -o cookies.txt
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

# Browser profile paths.
# Chrome-family newer builds store cookies under Default/Network/Cookies;
# older builds use Default/Cookies. Candidates are tried in order.
BROWSER_CONFIG = {
    "chrome": {
        "name": "Google Chrome",
        "cookie_candidates": {
            "darwin": [
                "Library/Application Support/Google/Chrome/Default/Network/Cookies",
                "Library/Application Support/Google/Chrome/Default/Cookies",
            ],
            "win32": [
                "AppData/Local/Google/Chrome/User Data/Default/Network/Cookies",
                "AppData/Local/Google/Chrome/User Data/Default/Cookies",
            ],
            "linux": [
                ".config/google-chrome/Default/Network/Cookies",
                ".config/google-chrome/Default/Cookies",
            ],
        },
        "local_state": {
            "darwin": "Library/Application Support/Google/Chrome/Local State",
            "win32": "AppData/Local/Google/Chrome/User Data/Local State",
            "linux": ".config/google-chrome/Local State",
        },
        "keychain_key": "Chrome Safe Storage",
        "encrypted": True,
    },
    "edge": {
        "name": "Microsoft Edge",
        "cookie_candidates": {
            "darwin": [
                "Library/Application Support/Microsoft Edge/Default/Network/Cookies",
                "Library/Application Support/Microsoft Edge/Default/Cookies",
            ],
            "win32": [
                "AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies",
                "AppData/Local/Microsoft/Edge/User Data/Default/Cookies",
            ],
            "linux": [
                ".config/microsoft-edge/Default/Network/Cookies",
                ".config/microsoft-edge/Default/Cookies",
            ],
        },
        "local_state": {
            "darwin": "Library/Application Support/Microsoft Edge/Local State",
            "win32": "AppData/Local/Microsoft/Edge/User Data/Local State",
            "linux": ".config/microsoft-edge/Local State",
        },
        "keychain_key": "Microsoft Edge Safe Storage",
        "encrypted": True,
    },
    "brave": {
        "name": "Brave Browser",
        "cookie_candidates": {
            "darwin": [
                "Library/Application Support/BraveSoftware/Brave-Browser/Default/Network/Cookies",
                "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
            ],
            "win32": [
                "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
                "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies",
            ],
            "linux": [
                ".config/BraveSoftware/Brave-Browser/Default/Network/Cookies",
                ".config/BraveSoftware/Brave-Browser/Default/Cookies",
            ],
        },
        "local_state": {
            "darwin": "Library/Application Support/BraveSoftware/Brave-Browser/Local State",
            "win32": "AppData/Local/BraveSoftware/Brave-Browser/User Data/Local State",
            "linux": ".config/BraveSoftware/Brave-Browser/Local State",
        },
        "keychain_key": "Brave Safe Storage",
        "encrypted": True,
    },
    "firefox": {
        "name": "Mozilla Firefox",
        "profiles_dir": {
            "darwin": "Library/Application Support/Firefox/Profiles",
            "win32": "AppData/Roaming/Mozilla/Firefox/Profiles",
            "linux": ".mozilla/firefox",
        },
        "encrypted": False,
    },
}


def get_home():
    return str(Path.home())


def get_platform():
    return sys.platform


def first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


def detect_browsers():
    """Detect installed browsers and their cookie database paths."""
    home = get_home()
    platform = get_platform()
    results = []

    for browser_id, config in BROWSER_CONFIG.items():
        if browser_id == "firefox":
            profiles_dir = os.path.join(home, config["profiles_dir"].get(platform, ""))
            if not os.path.isdir(profiles_dir):
                continue
            for entry in os.listdir(profiles_dir):
                cookie_db = os.path.join(profiles_dir, entry, "cookies.sqlite")
                if os.path.exists(cookie_db):
                    results.append({
                        "id": browser_id,
                        "name": config["name"],
                        "cookie_db_path": cookie_db,
                        "profile_path": os.path.join(profiles_dir, entry),
                    })
                    break
        else:
            candidates = [
                os.path.join(home, rel)
                for rel in config["cookie_candidates"].get(platform, [])
            ]
            cookie_db = first_existing(candidates)
            if cookie_db:
                results.append({
                    "id": browser_id,
                    "name": config["name"],
                    "cookie_db_path": cookie_db,
                    "profile_path": os.path.dirname(cookie_db),
                })

    return results


def open_cookie_db(cookie_db_path):
    """Open cookie DB from a copy (avoid lock issues with running browser)."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    try:
        shutil.copy2(cookie_db_path, tmp.name)
    except OSError as e:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        # Windows Chrome/Edge/Brave hold an exclusive lock while running.
        if get_platform() == "win32" and getattr(e, "winerror", None) in (32, 33):
            raise RuntimeError(
                "无法读取浏览器 Cookies 数据库：文件被浏览器独占锁定。\n"
                "在 Windows 上，Chrome/Edge/Brave 运行时会独占锁定 Cookies 文件。\n"
                "请优先使用网关的浏览器插件「Leo cookie.txt Locally」导出；\n"
                "或完全关闭对应浏览器后重试本脚本。"
            ) from e
        if e.errno in (11, 13, 16, 26):  # EAGAIN/EACCES/EBUSY/ETXTBSY-ish
            raise RuntimeError(
                "无法读取浏览器 Cookies 数据库：文件可能被浏览器锁定。\n"
                "请优先使用浏览器插件「Leo cookie.txt Locally」导出；\n"
                "或完全关闭对应浏览器后重试。"
            ) from e
        raise RuntimeError(f"Failed to copy cookie database: {e}") from e

    conn = sqlite3.connect(tmp.name)
    conn.row_factory = sqlite3.Row
    return conn, tmp.name


def get_chrome_key(browser_id):
    """Retrieve the AES decryption key for Chrome-family browsers."""
    platform = get_platform()
    config = BROWSER_CONFIG[browser_id]

    if platform == "darwin":
        return get_key_macos(config["keychain_key"])
    elif platform == "win32":
        local_state_rel = config["local_state"].get("win32", "")
        return get_key_windows(local_state_rel)
    elif platform.startswith("linux"):
        return get_key_linux(config["keychain_key"])
    else:
        raise RuntimeError(f"Unsupported platform: {platform}")


def get_key_macos(keychain_key):
    """Retrieve Chrome Safe Storage password from macOS Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-wa", keychain_key],
            capture_output=True, text=True, check=True,
        )
        password = result.stdout.strip()
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Failed to retrieve '{keychain_key}' from Keychain: {e.stderr}. "
            f"Grant access in the Keychain prompt."
        )

    # PBKDF2: salt='saltysalt', iterations=1003, keylen=16, sha1
    import hashlib
    return hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), b"saltysalt", 1003, dklen=16)


def get_key_windows(local_state_rel):
    """Retrieve Chrome decryption key via DPAPI on Windows."""
    import base64

    local_state_path = os.path.join(get_home(), local_state_rel)
    if not os.path.exists(local_state_path):
        raise RuntimeError("Chrome Local State file not found.")

    with open(local_state_path, "r", encoding="utf-8") as f:
        local_state = json.load(f)

    encrypted_key_b64 = local_state.get("os_crypt", {}).get("encrypted_key")
    if not encrypted_key_b64:
        raise RuntimeError("encrypted_key not found in Local State.")

    encrypted_key = base64.b64decode(encrypted_key_b64)
    if encrypted_key[:5] != b"DPAPI":
        raise RuntimeError("Unexpected key prefix in Local State.")

    # DPAPI decrypt via PowerShell
    key_bytes = encrypted_key[5:]
    hex_str = key_bytes.hex()
    ps_script = (
        f"Add-Type -AssemblyName System.Security; "
        f"[System.Security.Cryptography.ProtectedData]::Unprotect("
        f"[byte[]](-split ('{hex_str}' -split '(.{{2}})' -ne '' | "
        f"ForEach-Object {{ [Convert]::ToByte($_,16) }})), $null, 'CurrentUser') | "
        f"ForEach-Object {{ '{{0:X2}}' -f $_ }}"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, text=True, check=True, timeout=10,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"DPAPI decryption failed: {e.stderr}")

    # Parse hex bytes output
    hex_clean = result.stdout.strip().replace("\n", "").replace(" ", "")
    return bytes.fromhex(hex_clean)


def get_key_linux(keychain_key):
    """Retrieve Chrome key from Linux keyring or use fallback."""
    import hashlib

    try:
        result = subprocess.run(
            [
                "python3",
                "-c",
                (
                    "import secretstorage; bus=secretstorage.dbus_init(); "
                    "col=secretstorage.get_default_collection(bus); col.unlock(); "
                    f"target={keychain_key!r}; "
                    "\nfor item in col.get_all_items():\n"
                    "    if item.get_label()==target:\n"
                    "        print(item.get_secret().decode()); break"
                ),
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        password = (result.stdout or "").strip()
        if password:
            return hashlib.pbkdf2_hmac("sha1", password.encode(), b"saltysalt", 1, dklen=16)
    except Exception:
        pass

    # Fallback: "peanuts" (Linux Chrome default when no keyring)
    return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, dklen=16)


class AppBoundEncryptionError(RuntimeError):
    """Raised when Chrome app-bound encryption (v20) is encountered."""


def decrypt_chrome_value(encrypted_value, key):
    """Decrypt a single Chrome cookie value."""
    if not encrypted_value:
        return ""

    prefix = encrypted_value[:3]
    if prefix == b"v20":
        raise AppBoundEncryptionError(
            "检测到 Chrome app-bound encryption (v20)。本地脚本无法解密。\n"
            "请改用浏览器插件「Leo cookie.txt Locally」导出到网关。"
        )
    if prefix in (b"v10", b"v11"):
        try:
            from Crypto.Cipher import AES
        except ImportError as e:
            raise RuntimeError(
                "pycryptodome is required for Chrome cookie decryption. "
                "Install with: pip install pycryptodome"
            ) from e

        if sys.platform == "win32":
            # AES-256-GCM: nonce(12) + ciphertext + tag(16)
            nonce = encrypted_value[3:15]
            ciphertext = encrypted_value[15:-16]
            tag = encrypted_value[-16:]
            cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
            return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")
        else:
            # AES-128-CBC: IV = 16 spaces
            iv = b" " * 16
            cipher = AES.new(key, AES.MODE_CBC, iv=iv)
            decrypted = cipher.decrypt(encrypted_value[3:])
            # Strip PKCS7 padding
            pad_len = decrypted[-1]
            if 0 < pad_len <= 16:
                decrypted = decrypted[:-pad_len]
            return decrypted.decode("utf-8")
    else:
        # Older Chrome: no encryption
        return encrypted_value.decode("utf-8", errors="replace")


def read_chrome_cookies(conn, key, domain_filter=None):
    """Read and decrypt Chrome-family cookies."""
    if domain_filter:
        rows = conn.execute(
            "SELECT host_key, path, name, value, encrypted_value, is_secure, expires_utc "
            "FROM cookies WHERE host_key LIKE ?",
            (f"%{domain_filter}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT host_key, path, name, value, encrypted_value, is_secure, expires_utc "
            "FROM cookies"
        ).fetchall()

    cookies = []
    saw_v20 = False
    for row in rows:
        value = row["value"]
        enc = row["encrypted_value"]
        if not value and enc:
            if isinstance(enc, memoryview):
                enc = enc.tobytes()
            if enc[:3] == b"v20":
                saw_v20 = True
                continue
            try:
                value = decrypt_chrome_value(enc, key)
            except AppBoundEncryptionError:
                saw_v20 = True
                continue
            except Exception:
                continue
        if not value:
            continue
        # Chrome expires_utc is microseconds since 1601-01-01.
        expires_raw = row["expires_utc"] or 0
        try:
            expires = int(expires_raw // 1_000_000 - 11_644_473_600)
        except Exception:
            expires = 0
        cookies.append({
            "domain": row["host_key"],
            "path": row["path"],
            "name": row["name"],
            "value": value,
            "secure": bool(row["is_secure"]),
            "expires": expires if expires > 0 else 0,
        })

    if not cookies and saw_v20:
        raise AppBoundEncryptionError(
            "检测到 Chrome app-bound encryption (v20)，本地脚本无法解密这些 cookie。\n"
            "请改用浏览器插件「Leo cookie.txt Locally」：\n"
            "  1) 网关「浏览器插件」面板下载并加载扩展\n"
            "  2) 在「视频知识库 → Cookie 工具」点「用浏览器插件导出」\n"
            "  或点击扩展弹窗「导出到网关」"
        )
    return cookies


def read_firefox_cookies(conn, domain_filter=None):
    """Read Firefox cookies (plaintext)."""
    if domain_filter:
        rows = conn.execute(
            "SELECT host, path, name, value, isSecure, expiry FROM moz_cookies WHERE host LIKE ?",
            (f"%{domain_filter}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT host, path, name, value, isSecure, expiry FROM moz_cookies"
        ).fetchall()

    return [{
        "domain": row["host"],
        "path": row["path"],
        "name": row["name"],
        "value": row["value"],
        "secure": bool(row["isSecure"]),
        "expires": row["expiry"],
    } for row in rows]


def to_netscape_format(cookies):
    """Convert cookies to Netscape cookies.txt format."""
    lines = [
        "# Netscape HTTP Cookie File",
        "# This is a generated file!  Do not edit.",
        "",
    ]
    for c in cookies:
        include_sub = "TRUE" if c["domain"].startswith(".") else "FALSE"
        secure = "TRUE" if c["secure"] else "FALSE"
        expires = str(c["expires"]) if c["expires"] and c["expires"] > 0 else "0"
        lines.append(
            f"{c['domain']}\t{include_sub}\t{c['path']}\t{secure}\t{expires}\t{c['name']}\t{c['value']}"
        )
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Export browser cookies to Netscape format. "
            "Offline fallback path — prefer the Leo cookie.txt Locally extension when the gateway is available."
        )
    )
    parser.add_argument("--list-browsers", action="store_true", help="List detected browsers")
    parser.add_argument("--browser", type=str, help="Browser ID (chrome/edge/brave/firefox)")
    parser.add_argument("--list-domains", action="store_true", help="List cookie domains for the browser")
    parser.add_argument("--domain", type=str, help="Filter cookies by domain")
    parser.add_argument("--all", action="store_true", help="Export all cookies (no domain filter)")
    parser.add_argument("-o", "--output", type=str, default="cookies.txt", help="Output file path")
    args = parser.parse_args()

    if args.list_browsers:
        browsers = detect_browsers()
        if not browsers:
            print("No browsers detected.")
        for b in browsers:
            print(f"  {b['id']}: {b['name']} -> {b['cookie_db_path']}")
        print(
            "\nTip: If you are using the local-ai-gateway, prefer the browser extension "
            "'Leo cookie.txt Locally' (works while Chrome is open)."
        )
        return

    if not args.browser:
        parser.error("--browser is required (unless --list-browsers)")

    browsers = detect_browsers()
    browser = next((b for b in browsers if b["id"] == args.browser), None)
    if not browser:
        print(f"Error: Browser '{args.browser}' not found.")
        print("Available browsers:", ", ".join(b["id"] for b in browsers) or "none")
        sys.exit(1)

    config = BROWSER_CONFIG[args.browser]
    try:
        conn, tmp_db = open_cookie_db(browser["cookie_db_path"])
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        if args.list_domains:
            if config["encrypted"]:
                rows = conn.execute("SELECT DISTINCT host_key FROM cookies ORDER BY host_key").fetchall()
                domains = [r["host_key"] for r in rows]
            else:
                rows = conn.execute("SELECT DISTINCT host FROM moz_cookies ORDER BY host").fetchall()
                domains = [r["host"] for r in rows]
            print(f"Domains in {browser['name']} ({len(domains)} total):")
            for d in domains:
                print(f"  {d}")
            return

        if not args.domain and not args.all:
            parser.error("Specify --domain <domain> or --all to export cookies")

        if config["encrypted"]:
            key = get_chrome_key(args.browser)
            cookies = read_chrome_cookies(conn, key, args.domain)
        else:
            cookies = read_firefox_cookies(conn, args.domain)

        if not cookies:
            print(
                "Warning: 0 cookies exported. "
                "If Chrome is open on Windows, or cookies use app-bound encryption (v20), "
                "switch to the Leo cookie.txt Locally browser extension.",
                file=sys.stderr,
            )

        text = to_netscape_format(cookies)
        output_path = os.path.abspath(args.output)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass

        domains = sorted(set(c["domain"] for c in cookies))
        print(f"Exported {len(cookies)} cookies from {len(domains)} domains to: {output_path}")
        if domains:
            print(f"Domains: {', '.join(domains)}")
        print(f"\nUsage: yt-dlp --cookies \"{output_path}\" <URL>")
    except (AppBoundEncryptionError, RuntimeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
        try:
            os.unlink(tmp_db)
        except OSError:
            pass


if __name__ == "__main__":
    main()
