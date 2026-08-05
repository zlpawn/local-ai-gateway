# Browser Extension Cookie Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Chrome browser extension that exports decrypted cookies to the gateway, bypassing Chrome's app-bound encryption and file lock, with the existing local-file reader kept as fallback.

**Architecture:** Four independent units: (1) a Manifest V3 extension, (2) a persistence store for registered extensions, (3) REST routes, (4) frontend panel + video-kb integration. Both cookie paths funnel through the existing `toNetscapeFormat`.

**Tech Stack:** Node.js (ESM .mjs), TypeScript (esbuild), Chrome Extension MV3, no new npm dependencies.

## Global Constraints

- Branch: codex/lancedb-video-kb only. Never touch main.
- Test port: 8788. Main 8787 untouched.
- Extension name: Leo cookie.txt Locally
- host_permissions: ["<all_urls>"]
- Gateway URL default: http://127.0.0.1:8788
- No new npm dependencies.

---

## Task 1: Extension Registry Store
## Task 2: Extension REST Routes
## Task 3: Server Routing Integration
## Task 4: Extension Package
## Task 5: Frontend Browser Extensions Panel
## Task 6: Video-KB Cookie Panel Integration
## Task 7: Build, Restart, End-to-End Test