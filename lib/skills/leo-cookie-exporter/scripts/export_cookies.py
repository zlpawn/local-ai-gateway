#!/usr/bin/env python3
"""
Cookie Exporter - 导出本地浏览器 cookie 为 Netscape 格式 cookies.txt

支持浏览器: Chrome, Edge, Brave, Firefox
跨平台: macOS (Keychain), Windows (DPAPI), Linux (keyring/fallback)

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

# Browser profile paths
BROWSER_CONFIG = {
    "chrome": {
        "name": "Google Chrome",
        "darwin": "Library/Application Support/Google/Chrome/Default",
        "win32": "AppData/Local/Google/Chrome/User Data/Default",
        "linux": ".config/google-chrome/Default",
        "local_state": {
            "darwin": "Library/Application Support/Google/Chrome/Local State",
            "win32": "AppData/Local/Google/Chrome/User Data/Local State",
        },
        "keychain_key": "Chrome Safe Storage",
        "encrypted": True,
    },
    "edge": {
        "name": "Microsoft Edge",
        "darwin": "Library/Application Support/Microsoft Edge/Default",
        "win32": "AppData/Local/Microsoft/Edge/User Data/Default",
        "linux": ".config/microsoft-edge/Default",
        "local_state": {
            "darwin": "Library/Application Support/Microsoft Edge/Local State",
            "win32": "AppData/Local/Microsoft/Edge/User Data/Local State",
        },
        "keychain_key": "Microsoft Edge Safe Storage",
        "encrypted": True,
    },
    "brave": {
        "name": "Brave Browser",
        "darwin": "Library/Application Support/BraveSoftware/Brave-Browser/Default",
        "win32": "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default",
        "linux": ".config/BraveSoftware/Brave-Browser/Default",
        "local_state": {
            "darwin": "Library/Application Support/BraveSoftware/Brave-Browser/Local State",
            "win32": "AppData/Local/BraveSoftware/Brave-Browser/User Data/Local State",
        },
        "keychain_key": "Brave Safe Storage",
        "encrypted": True,
    },
    "firefox": {
        "name": "Mozilla Firefox",
        "darwin": "Library/Application Support/Firefox/Profiles",
        "win32": "AppData/Roaming/Mozilla/Firefox/Profiles",
        "linux": ".mozilla/firefox",
        "encrypted": False,
    },
}


def get_home():
    return str(Path.home())


def get_platform():
    return sys.platform


def detect_browsers():
    """Detect installed browsers and their cookie database paths."""
    home = get_home()
    platform = get_platform()
    results = []

    for browser_id, config in BROWSER_CONFIG.items():
        if browser_id == "firefox":
            profiles_dir = os.path.join(home, config.get(platform, ""))
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
            profile_dir = os.path.join(home, config.get(platform, ""))
            cookie_db = os.path.join(profile_dir, "Cookies")
            if os.path.exists(cookie_db):
                results.append({
                    "id": browser_id,
                    "name": config["name"],
                    "cookie_db_path": cookie_db,
                    "profile_path": profile_dir,
                })

    return results


def open_cookie_db(cookie_db_path):
    """Open cookie DB from a copy (avoid lock issues with running browser)."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    shutil.copy2(cookie_db_path, tmp.name)
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
    elif platform == "linux":
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
    from Crypto.Cipher import AES
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
        f"ForEach-Object {{ [Convert]::ToByte($_,16) }})), $null, 'CurrentUser')"
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
    try:
        import dbus
        bus = dbus.SessionBus()
        # Try gnome-keyring
        try:
            collection = dbus.SessionBus().get_object(
                "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default"
            )
            collection.Unlock()
            # Search for Chrome Safe Storage item
            for item_path in collection.SearchItems({"xdg:schema": "chrome_libsecret_os_crypt_password_v2"}):
                item = dbus.SessionBus().get_object("org.freedesktop.secrets", item_path)
                secret = item.GetSecret("org.freedesktop.Secret.Service", session_path)
                password = bytes(secret[2]).decode("utf-8")
                import hashlib
                return hashlib.pbkdf2_hmac("sha1", password.encode(), b"saltysalt", 1, dklen=16)
        except Exception:
            pass
    except ImportError:
        pass

    # Fallback: "peanuts" (Linux Chrome default when no keyring)
    import hashlib
    return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, dklen=16)


def decrypt_chrome_value(encrypted_value, key):
    """Decrypt a single Chrome cookie value."""
    if not encrypted_value:
        return ""

    prefix = encrypted_value[:3]
    if prefix in (b"v10", b"v11"):
        if sys.platform == "win32":
            # AES-256-GCM: nonce(12) + ciphertext + tag(16)
            from Crypto.Cipher import AES
            nonce = encrypted_value[3:15]
            ciphertext = encrypted_value[15:-16]
            tag = encrypted_value[-16:]
            cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
            return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")
        else:
            # AES-128-CBC: IV = 16 spaces
            from Crypto.Cipher import AES
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
    for row in rows:
        value = row["value"]
        if not value and row["encrypted_value"]:
            value = decrypt_chrome_value(row["encrypted_value"], key)
        if not value:
            continue
        cookies.append({
            "domain": row["host_key"],
            "path": row["path"],
            "name": row["name"],
            "value": value,
            "secure": bool(row["is_secure"]),
            "expires": int(row["expires_utc"] // 1_000_000 - 11644473600),
        })
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
        expires = str(c["expires"]) if c["expires"] > 0 else "FALSE"
        lines.append(f"{c['domain']}\t{include_sub}\t{c['path']}\t{secure}\t{expires}\t{c['name']}\t{c['value']}")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Export browser cookies to Netscape format.")
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
    conn, tmp_db = open_cookie_db(browser["cookie_db_path"])
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

        text = to_netscape_format(cookies)
        output_path = os.path.abspath(args.output)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(output_path, 0o600)

        domains = sorted(set(c["domain"] for c in cookies))
        print(f"Exported {len(cookies)} cookies from {len(domains)} domains to: {output_path}")
        print(f"Domains: {', '.join(domains)}")
        print(f"\nUsage: yt-dlp --cookies \"{output_path}\" <URL>")
    finally:
        conn.close()
        os.unlink(tmp_db)


if __name__ == "__main__":
    main()
