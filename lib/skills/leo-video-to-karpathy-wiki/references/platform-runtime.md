# Windows 与 macOS 运行规范

只在确定平台后读取本文件。不要把 Windows PowerShell 语法直接用于 macOS shell，也不要把 POSIX 命令直接用于 Windows。

## 平台与架构探测

### Windows PowerShell

```powershell
$platform = "windows"
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$tempBase = [System.IO.Path]::GetTempPath()
Get-Command ffmpeg, ffprobe, yt-dlp, whisper-ctranslate2 -ErrorAction SilentlyContinue
Get-Command nvidia-smi, nvcc -ErrorAction SilentlyContinue
```

### macOS

```bash
platform="macos"
arch="$(uname -m)"
temp_base="${TMPDIR:-/tmp}"
command -v ffmpeg
command -v ffprobe
command -v yt-dlp
command -v whisper-ctranslate2
command -v mlx_whisper
```

`arm64` 表示 Apple Silicon；`x86_64` 表示 Intel Mac。macOS 不进入 CUDA 分支。

## 路径规则

- 执行命令时始终将路径作为独立参数传递并完整引用，不拼接未经转义的 shell 字符串。
- Windows 文件操作优先使用 PowerShell `-LiteralPath`；macOS shell 参数使用双引号并在执行前通过参数数组传递。
- Manifest 统一记录规范化绝对路径；JSON 中使用 `/`，但实际文件操作使用平台原生路径 API。
- 不以字符串大小写或简单前缀判断目录包含关系。清理时遵守 [cleanup-policy.md](cleanup-policy.md) 的规范路径与链接检查。

## 临时目录

- Windows：`Join-Path ([System.IO.Path]::GetTempPath()) "video-to-karpathy-wiki\<run_id>"`
- macOS：`${TMPDIR:-/tmp}/video-to-karpathy-wiki/<run_id>`

目录必须由本次运行新建。若目标已经存在，生成新的 `run_id`，不得复用旧目录。

## 永久资产发布

下载、转写和审计草稿先在 `temp_root` 生成，不得把半成品直接写成最终永久资产。

1. 在 `temp_root` 完成生成、格式校验、大小校验和必要的媒体可读性校验。
2. 在最终目标目录内创建带 `run_id` 的同目录临时文件，例如 `.source.mp4.<run_id>.partial`。
3. 将已验证内容复制到该同目录临时文件，再次校验大小或 SHA-256。
4. 使用平台原生的同文件系统原子重命名替换为最终文件名：
   - Windows：使用 .NET/PowerShell 文件 API，传入绝对路径，不经 `cmd.exe`；
   - macOS：使用 `mv`/平台文件 API 在同一目标目录内重命名。
5. 仅在最终文件存在且验证通过后登记为 `permanent_assets`。
6. 发布失败时删除本次创建的 `.partial` 文件；若无法删除则登记为临时文件并进入安全清理流程。

目标最终文件已经存在时，不得在未获得用户覆盖许可的情况下执行替换。

## URL 下载

下载前先检查元数据和格式，限制为单个视频，避免意外下载整个播放列表：

```text
yt-dlp --no-playlist --dump-single-json <URL>
yt-dlp --no-playlist --write-info-json --continue --no-overwrites <URL>
```

实际调用时按平台安全传参。记录最终文件扩展名、format ID、视频/音频编码、来源 URL 和 extractor。分离流合并后的文件称为“下载归档容器”，不称为平台原始容器。

## ASR 选择与能力测试

只探测命令存在不等于后端可用。先对短音频片段执行能力测试，再处理完整视频。

1. Windows：
   - `nvidia-smi` 存在且 ASR 的 CUDA 短片段测试成功，才选择 CUDA；
   - 否则选择 CPU。
2. macOS Apple Silicon：
   - `mlx_whisper` 存在且短片段测试成功，优先 MLX；调用前用 `mlx_whisper -h` 核对当前版本参数，并显式指定模型，不依赖默认 tiny 模型；
   - 否则选择 `whisper-ctranslate2 --device cpu`。
3. macOS Intel：选择 CPU。
4. 加速后端失败时只回退一次 CPU；CPU 也失败则将 ASR 标记为 `failed`。

工具输出格式不一致时，必须转换为统一 Segment Schema：

```json
{
  "segment_id": "ASR-S0001",
  "start_seconds": 0.0,
  "end_seconds": 4.2,
  "text": "..."
}
```

## FFmpeg 引号

PowerShell 与 POSIX shell 对滤镜表达式的引号规则不同。优先使用参数数组调用进程；若必须写命令：

- PowerShell：将完整滤镜表达式作为一个参数传递，例如 `"select='gt(scene,0.3)'"`；
- macOS shell：使用 `'select=gt(scene\,0.3)'`。

执行后验证输出帧数量和时间戳，不以退出码 0 作为唯一成功依据。

## 运行环境记录

审计配置至少记录：

- OS 名称和版本；
- CPU 架构；
- `ffmpeg`、`ffprobe`、`yt-dlp` 版本；
- ASR 工具、版本、模型、设备和语言；
- OCR 工具及版本；
- pHash 实现和版本，或明确的禁用原因。
