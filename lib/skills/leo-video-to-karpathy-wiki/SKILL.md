---
name: video-to-karpathy-wiki
description: "将技术、架构或系统设计视频（URL 或本地文件）转写、抽帧审计并沉淀为 Karpathy 风格 Wiki。用户要求解析技术视频、制作系统设计视频笔记或归档到知识库时使用。支持 Windows 与 macOS。"
---

# Video to Karpathy LLM Wiki

## 10 步处理流水线

### 步骤 1：确定输入、平台与知识库根目录

1. 探测操作系统，只接受 `windows` 或 `macos`；其他系统明确报告未验证。
2. 确定 `knowledge_root`：优先使用用户指定目录，否则使用当前工作区根目录。
3. 识别输入源：
   - URL：由 `yt-dlp` 获取；
   - 本地文件：读取规范化绝对路径。
4. 检查目标 Wiki 是否已存在。存在时不得直接覆盖；获得用户选择后再覆盖或追加稳定后缀。
5. 按需读取并遵守 [跨平台运行规范](references/platform-runtime.md)。
6. 探测基础媒体工具：所有输入都需要 `ffmpeg` 与 `ffprobe`；URL 输入还需要 `yt-dlp`。缺少必需工具时停止并报告缺项，不进入资产生成步骤。

完成标准：已确定 `platform`、`knowledge_root`、`source_kind`、输入标识和不会意外覆盖的目标路径，且本次输入所需基础工具可用。

### 步骤 2：创建运行 Manifest

1. 生成唯一 `run_id`。
2. 在平台临时目录下创建本次运行独占的 `temp_root`：
   - Windows：`$env:TEMP\video-to-karpathy-wiki\<run_id>`;
   - macOS：`${TMPDIR:-/tmp}/video-to-karpathy-wiki/<run_id>`。
3. 按需读取并遵守 [安全清理规范](references/cleanup-policy.md)。
4. 在 `temp_root` 创建 `run_manifest.json`，使用规范化绝对路径登记运行元数据、`permanent_assets` 和 `temporary_files`。

完成标准：`temp_root` 是本次运行新建的独占目录，Manifest 可解析且初始状态为 `running`。

### 步骤 3：获取并归档源视频

1. 本地文件：在 `temp_root` 按字节复制并校验，保留输入容器和扩展名。
2. URL：使用 `yt-dlp` 下载至 `temp_root`；保留实际下载或合并产物的扩展名，不把它描述为平台“原始容器”。
3. URL 输入同时永久保存 `.info.json`，记录来源 URL、extractor、format ID、编码和下载时间。
4. 仅当用户明确要求转换格式时才使用 `ffmpeg` 重封装或转码，严禁只修改扩展名。
5. 验证产物后，按 [跨平台运行规范](references/platform-runtime.md) 发布到 `raw/assets/YYYY-MM-DD-主题/source.<ext>`；来源元数据一并发布。
6. 仅将发布成功的最终路径登记为 `permanent_assets`，所有下载分片和发布中间文件登记为临时文件。

完成标准：源视频存在、大小大于 0、可由 `ffprobe` 读取，URL 输入另有可解析的 `.info.json`。

### 步骤 4：探测 ASR 并生成结构化字幕

1. 按 [跨平台运行规范](references/platform-runtime.md) 探测 ASR 工具和加速后端，不假定命令存在即代表后端可用。
2. 选择 ASR：
   - Windows NVIDIA：仅在 CUDA 能力测试通过后使用 `whisper-ctranslate2 --device cuda`；
   - Windows 无可用 CUDA：使用 `whisper-ctranslate2 --device cpu`；
   - macOS Apple Silicon：优先使用可用的 `mlx_whisper`，否则使用 `whisper-ctranslate2 --device cpu`；
   - macOS Intel：使用 `whisper-ctranslate2 --device cpu`。
3. GPU/Metal 分支实际执行失败时回退 CPU；所有候选均失败则将 ASR 状态设为 `failed`，不得伪造字幕。
4. 在 `temp_root` 将工具原始输出规范化并验证为：
   - `raw/transcripts/YYYY-MM-DD-主题.transcript.json`：包含稳定 Segment ID、`start_seconds`、`end_seconds`、`text`；
   - `raw/transcripts/YYYY-MM-DD-主题.transcript.txt`：人类可读；
   - `.srt`：可选。
5. 验证通过后按 [跨平台运行规范](references/platform-runtime.md) 发布到上述最终路径，并登记为 `permanent_assets`。
6. 将所用 OS、CPU 架构、工具版本、模型、设备和语言参数记录到审计配置。

完成标准：JSON/TXT 均存在且大小大于 0；Segment ID 唯一，时间戳单调且位于视频时长内。

### 步骤 5：确定性抽帧与视觉审计

1. 固定采样：
   - 起点为 `00:00.000`；
   - 无条件提取首帧和结束前最后一个可解码帧；
   - 视频短于 2 小时，每 30.0 秒保底取样；否则每 45.0 秒；
   - 场景阈值固定为 `select='gt(scene,0.3)'`。
2. 候选帧命名为 `candidate_frames/frame_HHMMSS_mmm.jpg`。
3. 去重优先使用固定 pHash 实现：汉明距离不大于 6 且时间差不大于 2.0 秒时保留较早帧。若 pHash 依赖不可用，则禁用去重而不是改用未定义算法，并记录 `dedup_status: disabled_dependency_missing`。
4. 探测 PaddleOCR、Tesseract 或当前模型的图像理解能力：
   - 任一可用：逐帧审核并设 `visual_audit_status: complete`；
   - 图片可读但视觉处理执行异常：设为 `failed`；
   - 环境完全不能读取图片：设为 `blocked`。
5. 建立 Frame ID 与 Segment ID 的多对多关系。

完成标准：每个候选帧均登记且有审核状态；视觉状态只能是 `complete | blocked | failed`。

### 步骤 6：生成审计账本草稿

1. 按需读取并遵守 [审计账本规范](references/audit-schema.md)。
2. 在 `temp_root` 创建 `audit.draft.json` 和 `audit.draft.md`。
3. 构建从 `0.0` 到视频时长连续无缝的 `coverage_windows`。
4. 建立 `frames` 登记册，记录 Frame ID、时间戳、SHA-256、审核状态、临时生命周期和 `used_as_evidence: false`。
5. 所有事实和提炼要点必须引用 Segment ID 或 Frame ID；模糊内容进入 `unconfirmed_items`。
6. 强制状态映射：
   - `visual_audit_status: complete` → `overall_status: complete`；
   - `visual_audit_status: blocked` → `overall_status: partial`；
   - `visual_audit_status: failed` → `overall_status: failed`。

完成标准：草稿可解析，覆盖窗口连续，所有 Segment/Frame ID 引用均可解析，状态映射合法。

### 步骤 7：撰写三层隔离内容

按需读取并遵守 [Wiki 格式规范](references/wiki-format.md)，严格区分：

1. `📌 原视频事实`：引用 Segment ID 或 Frame ID；
2. `💡 合理推导`：显式标记为推导；
3. `🛠️ 延伸工程实现`：根据视频与用户需求选择技术栈，不得声称为讲者原方案。

若 `overall_status: failed`，停止生成成功版 Wiki，只输出失败报告和可恢复建议。

完成标准：每条事实可追溯，推导与补充实现没有混入事实层。

### 步骤 8：生成 Wiki、提升证据帧、冻结账本并更新索引

1. 生成 `系统设计/YYYYMMDD_主题.md` 或与内容匹配的 `技术专题/` 页面，包含基于证据的忠实蓝图。
2. 按需读取并遵守 [SVG 样式规范](references/light-svg-style.md)，生成浅色高对比 SVG；正文使用相对 Markdown 路径。
3. 只将 `used_as_evidence == true` 的帧提升到 `raw/assets/YYYY-MM-DD-主题/evidence_frames/`：
   - 更新 `evidence_path`、`evidence_for`、`promoted: true`、`retention: permanent`；
   - 未提升帧保留 `candidate_path_at_review`、`promoted: false`、`retention: temporary`，不得暗示临时路径永久有效。
4. 更新草稿中的最终路径和状态，将最终账本一次性写入 `raw/audits/`。写入后不得再修改这些 Layer 1 账本。
5. 幂等更新 `index.md` 与 `log.md`：
   - 先读取现有格式；
   - 以最终 Wiki 相对路径为唯一键；
   - 已存在则更新，不存在则新增；
   - 将二者登记为 `permanent_assets`。

完成标准：Wiki、SVG、证据帧、冻结账本及索引引用相互一致，无重复索引项。

### 步骤 9：执行清理前门槛

执行下文全部 Pre-Cleanup Gates。任何必需门槛失败时，不得进入正常完成结论；保留 Manifest 和诊断信息。

### 步骤 10：呈报并可选清理

1. 按 [安全清理规范](references/cleanup-policy.md) 展示临时文件的规范化绝对路径和总大小。
2. 用户授权后逐个处理，每项记录 `deleted | retained | failed`。
3. 全部删除成功并通过 Post-Cleanup Gates 后，才设置 `status: cleaned`。
4. 用户跳过时设置 `status: completed_cleanup_skipped`。
5. 任一清理项失败时设置 `status: cleanup_failed` 并记录错误；不得设置为 `cleaned`。

## Completion Gates

### Pre-Cleanup Gates

- [ ] 输入源、目标路径和平台已确定，未发生未经许可的覆盖；
- [ ] 源视频存在、大小大于 0 且 `ffprobe` 可读；
- [ ] URL 输入具有永久保存的 `.info.json`；
- [ ] `transcript.json` 与 `transcript.txt` 存在、非空且时间戳有效；
- [ ] 冻结账本已写入 `raw/audits/`，`coverage_windows` 连续覆盖完整时长；
- [ ] 所有 Segment ID、Frame ID 和事实引用均可解析；
- [ ] 所有 `used_as_evidence == true` 的帧已提升并登记为永久资产；
- [ ] `visual_audit_status == complete` 时，候选帧审计率为 100%；
- [ ] `visual_audit_status == blocked` 时，`overall_status == partial`，只能声明视觉受阻的部分完成；
- [ ] `visual_audit_status == failed` 时，`overall_status == failed`，不得声明任务成功；
- [ ] `unconfirmed_items` 已显式公开；
- [ ] Wiki 保持事实、推导和延伸实现三层隔离；
- [ ] `index.md` 与 `log.md` 已幂等更新；
- [ ] Manifest 中所有路径均通过对应平台的规范化和边界检查。

### Post-Cleanup Gates

- [ ] 用户授权且全部临时文件删除成功：所有条目为 `deleted`，永久资产仍存在且非空，然后设置 `status: cleaned`；
- [ ] 用户跳过：设置 `status: completed_cleanup_skipped`，文件保持不变；
- [ ] 任一清理失败：设置 `status: cleanup_failed`，失败条目包含错误信息；
- [ ] `cleaned`、`completed_cleanup_skipped`、`cleanup_failed` 三种终态互斥。
