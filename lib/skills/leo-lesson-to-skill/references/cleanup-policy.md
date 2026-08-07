# 基于 Manifest 运行清单的安全清理规范

## 一、 Manifest 运行清单 Schema

任务启动时，必须在本次运行新建的专属临时目录下创建 `run_manifest.json`。Windows 与 macOS 均适用。**Manifest 内所有文件路径统一使用规范化绝对路径 (Normalized Absolute Paths)**：

```json
{
  "run_id": "RUN_20260726_PERFORMANCE_REVIEW",
  "status": "running",
  "created_at": "2026-07-26T18:00:00Z",
  "platform": "macos",
  "source_inputs": ["/Users/example/Downloads/video1.mp4", "/Users/example/Downloads/video2.mp4"],
  "temp_root": "/private/var/folders/.../leo-lesson-to-skill/RUN_20260726_PERFORMANCE_REVIEW/",
  "permanent_assets": [
    "/Users/example/.agents/skills/leo-performance-review/SKILL.md",
    "/Users/example/.agents/skills/leo-performance-review/references/述职框架.md"
  ],
  "temporary_files": [
    {
      "path": "/private/var/folders/.../leo-lesson-to-skill/RUN_20260726_PERFORMANCE_REVIEW/candidate_frames/frame_000010_000.jpg",
      "created_by_run": true,
      "size_bytes": 124500,
      "status": "pending",
      "deleted_at": null,
      "error": null
    }
  ]
}
```

`source_inputs` 为数组以支持多视频输入。`permanent_assets` 记录最终发布的 skill 文件和保留的证据帧。

## 二、 强边界安全清理

1. **临时路径作用域限定**：所有被清除的临时文件，规范化绝对路径必须严格位于本次运行专属的 `temp_root` 目录下。
   - Windows：使用平台路径 API 取得完整路径；路径包含关系按 Windows 大小写不敏感语义判断，并拒绝带 `ReparsePoint` 属性的目标。
   - macOS：使用 `realpath`/等价平台 API 解析根目录和目标父目录；通过路径组件关系判断包含关系，并拒绝符号链接。
   - 两个平台都不得使用字符串 `StartsWith`、简单大小写转换或手工拼接来证明目标位于 `temp_root`。
2. **优先保护冲突项**：同一路径若同时存在于 `permanent_assets` 与 `temporary_files`，**永久资产拥有绝对优先权，严禁删除**。
3. **拒绝非正则文件**：删除前对每个目标执行 `lstat`/平台等价检查，只允许删除常规文件；拒绝目录、Symlink、Junction 和 Reparse Point。
4. **归属验证**：每个清理目标必须校验 `created_by_run == true`。
5. **严禁通配符整目录盲删**：严禁执行类似 `rm -rf dir/*` 的通配符模糊删除。
6. **删除前呈报**：向用户展示即将删除的临时文件绝对路径清单与拟释放空间大小。
7. **显式许可与状态更新**：
   - 获得用户许可后逐项处理并立即写入文件级结果；
   - 全部成功清除且重新验证永久资产后，才更新 Manifest `"status": "cleaned"`；
   - 若用户拒绝/跳过清理，更新 Manifest `"status": "completed_cleanup_skipped"`；
   - 若部分文件清理出错，更新 Manifest `"status": "cleanup_failed"`，并在每个文件项记录 `"status": "deleted" | "retained" | "failed"`, `"deleted_at"`, `"error"`。
