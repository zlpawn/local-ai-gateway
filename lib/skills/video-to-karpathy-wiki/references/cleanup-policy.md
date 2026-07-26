# 基于 Manifest 运行清单的安全清理规范 (Manifest Cleanup Reference)

## 一、 Manifest 运行清单 Schema

任务启动时，必须在本次运行新建的专属临时目录下创建 `run_manifest.json`。Windows 与 macOS 均适用。**Manifest 内所有文件路径统一使用规范化绝对路径 (Normalized Absolute Paths)**：

```json
{
  "run_id": "RUN_20260726_JOB_SCHEDULER",
  "status": "running",
  "created_at": "2026-07-26T18:00:00Z",
  "platform": "windows",
  "source_input": "C:/Users/example/Downloads/video.mp4",
  "temp_root": "C:/Users/example/AppData/Local/Temp/video-to-karpathy-wiki/RUN_20260726_JOB_SCHEDULER/",
  "permanent_assets": [
    "D:/Knowledge/raw/assets/2026-07-26-任务调度系统/source.mp4",
    "D:/Knowledge/raw/assets/2026-07-26-任务调度系统/evidence_frames/frame_000418_250.jpg",
    "D:/Knowledge/raw/transcripts/2026-07-26-任务调度系统.transcript.json",
    "D:/Knowledge/raw/transcripts/2026-07-26-任务调度系统.transcript.txt",
    "D:/Knowledge/raw/audits/2026-07-26-任务调度系统.audit.json",
    "D:/Knowledge/系统设计/20260726_任务调度系统.md"
  ],
  "temporary_files": [
    {
      "path": "C:/Users/example/AppData/Local/Temp/video-to-karpathy-wiki/RUN_20260726_JOB_SCHEDULER/candidate_frames/frame_000010_000.jpg",
      "created_by_run": true,
      "size_bytes": 124500,
      "status": "pending",
      "deleted_at": null,
      "error": null
    }
  ]
}
```

---

## 二、 强边界安全清理与证据帧提升标准

1. **绝对提升准则 (Promotion Rule)**：在步骤 8 执行清理前，**只有在审计账本或 Wiki 正文中 `used_as_evidence == true` 的候选帧**才允许提升移动至 `evidence_frames/` 并登记为 `permanent_assets`。未作为证据引用的候选帧继续保留在临时列表中等待清理。
2. **临时路径作用域限定**：所有被清除的临时文件，规范化绝对路径必须严格位于本次运行专属的 `temp_root` 目录下。
   - Windows：使用平台路径 API 取得完整路径；路径包含关系按 Windows 大小写不敏感语义判断，并拒绝带 `ReparsePoint` 属性的目标。
   - macOS：使用 `realpath`/等价平台 API 解析根目录和目标父目录；通过路径组件关系判断包含关系，并拒绝符号链接。
   - 两个平台都不得使用字符串 `StartsWith`、简单大小写转换或手工拼接来证明目标位于 `temp_root`。
3. **优先保护冲突项**：同一路径若同时存在于 `permanent_assets` 与 `temporary_files`，**永久资产拥有绝对优先权，严禁删除**。
4. **拒绝非正则文件**：删除前对每个目标执行 `lstat`/平台等价检查，只允许删除常规文件；拒绝目录、Symlink、Junction 和 Reparse Point。
5. **归属验证**：每个清理目标必须校验 `created_by_run == true`。
6. **严禁通配符整目录盲删**：严禁执行类似 `rm -rf dir/*` 的通配符模糊删除。
7. **删除前呈报**：向用户展示即将删除的临时文件绝对路径清单与拟释放空间大小。
8. **显式许可与状态更新**：
   - 获得用户许可后逐项处理并立即写入文件级结果；
   - 全部成功清除且重新验证永久资产后，才更新 Manifest `"status": "cleaned"`；
   - 若用户拒绝/跳过清理，更新 Manifest `"status": "completed_cleanup_skipped"`；
   - 若部分文件清理出错，更新 Manifest `"status": "cleanup_failed"`，并在每个文件项记录 `"status": "deleted" | "retained" | "failed"`, `"deleted_at"`, `"error"`。

## 三、 平台示例

macOS 的 Manifest 路径示例：

```json
{
  "platform": "macos",
  "source_input": "/Users/example/Downloads/video.mov",
  "temp_root": "/private/var/folders/.../video-to-karpathy-wiki/RUN_20260726_JOB_SCHEDULER/",
  "permanent_assets": [
    "/Users/example/Knowledge/raw/assets/2026-07-26-主题/source.mov"
  ]
}
```

示例仅说明路径形态。实际路径必须在运行时探测，禁止硬编码用户名或磁盘盘符。
