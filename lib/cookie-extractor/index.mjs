import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Cookie extractor: reads cookies from local browser SQLite databases,
 * decrypts them using OS keychain/DPAPI, and exports Netscape-format
 * cookies.txt for use with yt-dlp and similar tools.
 *
 * Supported browsers: Chrome, Edge, Brave, Firefox.
 * Chrome-family cookies are AES-encrypted; the key is retrieved from
 * macOS Keychain / Windows DPAPI / Linux keyring.
 * Firefox cookies are stored in plaintext.
 */

const BROWSER_PROFILES = {
  chrome: {
    name: "Google Chrome",
    darwin: (p) => path.join(p, "Library/Application Support/Google/Chrome/Default/Cookies"),
    win32: (p) => path.join(p, "AppData/Local/Google/Chrome/User Data/Default/Cookies"),
    linux: (p) => path.join(p, ".config/google-chrome/Default/Cookies"),
    localState: { darwin: "Library/Application Support/Google/Chrome/Local State", win32: "AppData/Local/Google/Chrome/User Data/Local State" },
    keychainKey: "Chrome Safe Storage",
    encrypted: true,
  },
  edge: {
    name: "Microsoft Edge",
    darwin: (p) => path.join(p, "Library/Application Support/Microsoft Edge/Default/Cookies"),
    win32: (p) => path.join(p, "AppData/Local/Microsoft/Edge/User Data/Default/Cookies"),
    linux: (p) => path.join(p, ".config/microsoft-edge/Default/Cookies"),
    localState: { darwin: "Library/Application Support/Microsoft Edge/Local State", win32: "AppData/Local/Microsoft/Edge/User Data/Local State" },
    keychainKey: "Microsoft Edge Safe Storage",
    encrypted: true,
  },
  brave: {
    name: "Brave Browser",
    darwin: (p) => path.join(p, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"),
    win32: (p) => path.join(p, "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies"),
    linux: (p) => path.join(p, ".config/BraveSoftware/Brave-Browser/Default/Cookies"),
    localState: { darwin: "Library/Application Support/BraveSoftware/Brave-Browser/Local State", win32: "AppData/Local/BraveSoftware/Brave-Browser/User Data/Local State" },
    keychainKey: "Brave Safe Storage",
    encrypted: true,
  },
  firefox: {
    name: "Mozilla Firefox",
    darwin: (p) => path.join(p, "Library/Application Support/Firefox/Profiles"),
    win32: (p) => path.join(p, "AppData/Roaming/Mozilla/Firefox/Profiles"),
    linux: (p) => path.join(p, ".mozilla/firefox"),
    encrypted: false,
  },
};

/**
 * Detect installed browsers and their cookie database paths.
 * @returns {Array<{id, name, cookieDbPath, profilePath, encrypted}>}
 */
export function detectBrowsers() {
  const home = os.homedir();
  const platform = process.platform;
  const results = [];

  for (const [id, config] of Object.entries(BROWSER_PROFILES)) {
    if (id === "firefox") {
      const profilesDir = config[platform]?.(home);
      if (!profilesDir || !fs.existsSync(profilesDir)) continue;
      // Firefox has multiple profile dirs, pick the one with cookies.sqlite
      for (const entry of fs.readdirSync(profilesDir)) {
        const cookieDb = path.join(profilesDir, entry, "cookies.sqlite");
        if (fs.existsSync(cookieDb)) {
          results.push({ id, name: config.name, cookieDbPath: cookieDb, profilePath: path.join(profilesDir, entry), encrypted: false });
          break; // first profile with cookies
        }
      }
    } else {
      const cookieDb = config[platform]?.(home);
      if (cookieDb && fs.existsSync(cookieDb)) {
        results.push({ id, name: config.name, cookieDbPath: cookieDb, profilePath: path.dirname(cookieDb), encrypted: true });
      }
    }
  }
  return results;
}

/**
 * List all cookie domains in a browser's cookie database.
 * @param {{browser: string}} opts
 * @returns {string[]} sorted unique domain names
 */
export function listCookieDomains({ browser }) {
  const detected = detectBrowsers().find((b) => b.id === browser);
  if (!detected) throw new Error(`Browser '${browser}' not found.`);
  const db = openCookieDb(detected.cookieDbPath);
  try {
    if (detected.encrypted) {
      const rows = db.prepare("SELECT DISTINCT host_key FROM cookies ORDER BY host_key").all();
      return rows.map((r) => r.host_key);
    } else {
      const rows = db.prepare("SELECT DISTINCT host FROM moz_cookies ORDER BY host").all();
      return rows.map((r) => r.host);
    }
  } finally {
    db.close();
  }
}

/**
 * Extract cookies and export as Netscape-format cookies.txt.
 * @param {{browser: string, domain?: string, outputPath: string}} opts
 * @returns {{file_path: string, count: number, domains: string[]}}
 */
export async function extractCookies({ browser, domain, outputPath }) {
  const detected = detectBrowsers().find((b) => b.id === browser);
  if (!detected) throw new Error(`Browser '${browser}' not found.`);

  const db = openCookieDb(detected.cookieDbPath);
  let cookies;
  try {
    if (detected.encrypted) {
      const key = getChromeDecryptionKey(browser);
      cookies = readChromeCookies(db, key, domain);
    } else {
      cookies = readFirefoxCookies(db, domain);
    }
  } finally {
    db.close();
  }

  const text = toNetscapeFormat(cookies);
  fs.writeFileSync(outputPath, text, { mode: 0o600 });
  const domains = [...new Set(cookies.map((c) => c.domain))].sort();
  return { file_path: outputPath, count: cookies.length, domains };
}

// --- internals ---

function openCookieDb(cookieDbPath) {
  // Browser may have the DB locked (WAL mode). Copy to temp file.
  const tmpDir = os.tmpdir();
  const tmpDb = path.join(tmpDir, `cookie-${Date.now()}.db`);
  fs.copyFileSync(cookieDbPath, tmpDb);
  const db = new DatabaseSync(tmpDb, { readOnly: true });
  db.exec("PRAGMA journal_mode = WAL;");
  // Override close to also delete the temp file
  const origClose = db.close.bind(db);
  db.close = () => {
    try { origClose(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
  };
  return db;
}

function getChromeDecryptionKey(browser) {
  const platform = process.platform;
  if (platform === "darwin") {
    return getChromeKeyMacOS(BROWSER_PROFILES[browser].keychainKey);
  } else if (platform === "win32") {
    return getChromeKeyWindows(BROWSER_PROFILES[browser].localState?.win32);
  } else if (platform === "linux") {
    return getChromeKeyLinux();
  }
  throw new Error(`Chrome cookie decryption not supported on ${platform}`);
}

function getChromeKeyMacOS(keychainKey) {
  // Retrieve the Safe Storage password from macOS Keychain
  let password;
  try {
    password = execSync(`security find-generic-password -wa "${keychainKey}"`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`Failed to retrieve '${keychainKey}' from macOS Keychain. Grant access in the Keychain prompt.`);
  }
  // Derive AES key: PBKDF2(password, salt='saltysalt', iterations=1003, keylen=16)
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function getChromeKeyWindows(localStateRelPath) {
  // Read Local State JSON to get encrypted_key
  const home = os.homedir();
  const localStatePath = path.join(home, localStateRelPath);
  if (!fs.existsSync(localStatePath)) throw new Error("Chrome Local State file not found.");
  const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const encryptedKeyB64 = localState.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) throw new Error("encrypted_key not found in Local State.");
  // Remove 'DPAPI' prefix (5 bytes after base64 decode)
  const encryptedKey = Buffer.from(encryptedKeyB64, "base64");
  if (encryptedKey.slice(0, 5).toString() !== "DPAPI") throw new Error("Unexpected key prefix.");
  // Decrypt using DPAPI via PowerShell
  const keyHex = encryptedKey.slice(5).toString("hex");
  const script = `Add-Type -AssemblyName System.Security; [System.Security.Cryptography.ProtectedData]::Unprotect([byte[]](-split ('${keyHex}' -split '(.{2})' -ne '' | ForEach-Object { [Convert]::ToByte($_,16) })), $null, 'CurrentUser') | ForEach-Object { '{0:X2}' -f $_ }`;
  let decryptedHex;
  try {
    decryptedHex = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  } catch {
    throw new Error("Failed to decrypt Chrome key via DPAPI. Run the gateway as the current user.");
  }
  return Buffer.from(decryptedHex.replace(/\s/g, ""), "hex");
}

function getChromeKeyLinux() {
  // Try gnome-keyring via secretstore, fallback to "peanuts"
  try {
    const result = execSync(`python3 -c "import secretstorage; bus=secretstorage.dbus_init(); col=secretstorage.get_collection(bus); col.unlock(); for item in col.get_all_items(): 
  if item.get_label()=='Chrome Safe Storage': print(item.get_secret().decode()); break"`, { encoding: "utf8", timeout: 5000 }).trim();
    if (result) return pbkdf2Sync(result, "saltysalt", 1, 16, "sha1");
  } catch { /* fallback */ }
  // Default fallback for Linux Chrome
  return pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
}

function readChromeCookies(db, key, domainFilter) {
  let query = "SELECT host_key, path, name, value, encrypted_value, is_secure, is_httponly, expires_utc FROM cookies";
  const params = [];
  if (domainFilter) {
    query += " WHERE host_key LIKE ?";
    params.push(`%${domainFilter}%`);
  }
  const rows = db.prepare(query).all(...params);
  return rows.map((row) => {
    let value = row.value;
    if (!value && row.encrypted_value) {
      value = decryptChromeValue(row.encrypted_value, key);
    }
    return {
      domain: row.host_key,
      path: row.path,
      name: row.name,
      value: value || "",
      secure: Boolean(row.is_secure),
      httponly: Boolean(row.is_httponly),
      expires: Math.floor(row.expires_utc / 1e6 - 11644473600), // Chrome epoch to Unix
    };
  }).filter((c) => c.value !== "");
}

function decryptChromeValue(encryptedValue, key) {
  const buf = Buffer.from(encryptedValue);
  // v10+ prefix
  const prefix = buf.slice(0, 3).toString();
  if (prefix === "v10" || prefix === "v11") {
    const nonce = buf.slice(3, 15); // 12 bytes
    const ciphertext = buf.slice(15, -16); // without tag
    const tag = buf.slice(-16); // 16 bytes
    // AES-256-GCM on Windows, AES-128-CBC on macOS/Linux
    if (process.platform === "win32") {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } else {
      // macOS/Linux: AES-128-CBC, IV = 16 spaces
      const iv = Buffer.alloc(16, 0x20);
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      let decrypted = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
      // Strip PKCS7 padding
      const padLen = decrypted[decrypted.length - 1];
      if (padLen > 0 && padLen <= 16) decrypted = decrypted.slice(0, -padLen);
      return decrypted.toString("utf8");
    }
  }
  // Older versions: no encryption
  return buf.toString("utf8");
}

function readFirefoxCookies(db, domainFilter) {
  let query = "SELECT host, path, name, value, isSecure, isHttpOnly, expiry FROM moz_cookies";
  const params = [];
  if (domainFilter) {
    query += " WHERE host LIKE ?";
    params.push(`%${domainFilter}%`);
  }
  const rows = db.prepare(query).all(...params);
  return rows.map((row) => ({
    domain: row.host,
    path: row.path,
    name: row.name,
    value: row.value,
    secure: Boolean(row.isSecure),
    httponly: Boolean(row.isHttpOnly),
    expires: row.expiry,
  }));
}

export function toNetscapeFormat(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# This is a generated file!  Do not edit.",
    "",
  ];
  for (const c of cookies) {
    const includeSubdomains = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = c.expires > 0 ? String(c.expires) : "FALSE";
    lines.push(`${c.domain}\t${includeSubdomains}\t${c.path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
  }
  return lines.join("\n") + "\n";
}
