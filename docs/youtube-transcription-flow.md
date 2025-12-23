# YouTube 转录流程

本文档描述了后端服务处理 YouTube 视频转录的完整流程。

## 概述

系统采用**双层策略**处理 YouTube 视频转录：

1. **优先方案**：直接提取 YouTube 字幕（免费、快速）
2. **备用方案**：下载音频 + Deepgram 转录（需要消耗配额）

## 流程图

```
YouTube URL
    │
    ▼
┌───────────────────────┐
│ 尝试提取 YouTube 字幕  │
│ (YouTubeTranscriptService)
└───────────┬───────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
 有字幕           无字幕
    │               │
    ▼               ▼
 保存结果      ┌───────────────────┐
 cost=0       │ 下载音频 (yt-dlp)  │
              │ + Cookies 认证     │
              └─────────┬─────────┘
                        │
                        ▼
              ┌───────────────────┐
              │ Deepgram 转录     │
              └─────────┬─────────┘
                        │
                        ▼
                    保存结果
                cost=ceil(duration/60)
```

## 详细流程

### 1. YouTube 字幕提取（优先）

**文件**：`src/providers/youtube/youtube-transcript.service.ts`

使用 `youtube-caption-extractor` 包直接从 YouTube 获取视频字幕。

**多语言支持**：
- 前端可通过 `params.language` 指定字幕语言
- 支持的语言代码：`zh`（中文）、`en`（英文）、`ja`（日文）等
- 如果指定语言的字幕不存在，会获取默认语言

**优点**：
- 免费（不消耗 Deepgram 配额）
- 快速（无需下载音频）
- 质量高（官方字幕或自动生成字幕）
- 支持多语言字幕

**限制**：
- 部分视频没有字幕
- 无法获取说话人信息

**代码示例**：
```typescript
const transcript = await this.youtubeTranscript.getTranscript(youtubeUrl);
if (transcript) {
  // 有字幕，直接使用
  // cost_minutes = 0
}
```

### 2. 音频下载 + Deepgram 转录（备用）

当视频没有字幕时，回退到传统流程：

#### 2.1 下载音频

**文件**：`src/providers/youtube/youtube-downloader.service.ts`

使用 `yt-dlp` 下载 YouTube 视频的音频轨道。

**关键参数**：
```bash
yt-dlp \
  -f 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best' \
  --output '/tmp/youtube/xxx.%(ext)s' \
  --print 'after_move:filepath' \
  --cookies /tmp/youtube/cookies-xxx.txt \
  <youtube_url>
```

**优化说明**：
- **不转码**：直接下载原始音频格式，避免 ffmpeg 转码耗时
- **格式优先级**：优先 m4a，其次 webm，最后任意格式
- **动态扩展名**：使用 `%(ext)s` 模板，由 yt-dlp 自动填充
- **Deepgram 兼容**：Deepgram 支持多种音频格式（m4a、webm、opus 等）

**Cookies 处理**：
- 从 `/app/cookies/youtube.txt`（只读）复制到 `/tmp/youtube/`（可写）
- 设置 `chmod 666` 权限，因为 yt-dlp 需要写入 cookies

#### 2.2 上传到 R2

音频下载后上传到 Cloudflare R2 存储，生成可访问的 URL。

#### 2.3 Deepgram 转录

**文件**：`src/providers/deepgram/deepgram.service.ts`

将音频 URL 提交给 Deepgram API 进行转录。

**功能**：
- 语音识别
- 说话人分离 (diarization)
- 自动语言检测

## Cookies 配置

### 为什么需要 Cookies？

YouTube 会检测数据中心 IP（如 Cloud Run），对可疑请求要求登录验证。Cookies 可以绕过这个限制。

### 配置步骤

1. **获取 Cookies**：
   - 使用浏览器扩展（如 "Get cookies.txt"）导出 YouTube cookies
   - 格式为 Netscape HTTP Cookie File

2. **存储到 Secret Manager**：
   ```bash
   gcloud secrets create YOUTUBE_COOKIES --data-file=cookies.txt
   ```

3. **授权 Cloud Run 访问**：
   ```bash
   gcloud secrets add-iam-policy-binding YOUTUBE_COOKIES \
     --member="serviceAccount:YOUR_SA@PROJECT.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   ```

4. **Cloud Run 部署配置** (cloudbuild.yaml)：
   ```yaml
   --set-secrets "/app/cookies/youtube.txt=YOUTUBE_COOKIES:latest"
   ```

### Cookies 有效期

YouTube cookies 通常在几个月后过期。需要定期更新：

1. 重新导出 cookies
2. 更新 Secret Manager：
   ```bash
   gcloud secrets versions add YOUTUBE_COOKIES --data-file=new_cookies.txt
   ```
3. 重新部署服务（或触发新版本）

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/providers/youtube/youtube.service.ts` | YouTube URL 解析、视频信息获取 |
| `src/providers/youtube/youtube-transcript.service.ts` | YouTube 字幕提取服务 |
| `src/providers/youtube/youtube-downloader.service.ts` | yt-dlp 音频下载服务 |
| `src/modules/tasks/task-processor.service.ts` | 任务处理核心逻辑 |
| `cloudbuild.yaml` | Cloud Build 部署配置 |

## 费用说明

| 方案 | 费用 |
|------|------|
| YouTube 字幕提取 | 免费 (cost_minutes = 0) |
| Deepgram 转录 | 按时长计费 (cost_minutes = ceil(duration/60)) |

## 错误处理

### 常见错误

1. **"Sign in to confirm you're not a bot"**
   - 原因：YouTube 检测到数据中心 IP
   - 解决：配置 Cookies

2. **"No transcript available"**
   - 原因：视频没有字幕
   - 处理：自动回退到 Deepgram 转录

3. **"No video formats found"**
   - 原因：yt-dlp 版本过旧或 cookies 无效
   - 解决：更新 yt-dlp 到最新版本，检查 cookies 是否过期

4. **"Requested format is not available"**
   - 原因：指定的音频格式不可用
   - 解决：使用 `-f bestaudio/best` 自动选择最佳可用格式

5. **"PermissionError: Permission denied" (cookies 文件)**
   - 原因：Secret Manager 挂载的文件是只读的，yt-dlp 需要写入权限
   - 解决：复制 cookies 到 `/tmp` 目录并设置可写权限

6. **yt-dlp 下载失败**
   - 原因：Cookies 过期或视频受限
   - 解决：更新 Cookies 或检查视频权限

## 更新日志

- **2025-12-23**（第二次更新）：
  - 添加多语言字幕支持（通过 `params.language` 指定）
  - 优化 yt-dlp 下载性能：移除 ffmpeg 转码，直接下载原始格式
  - 修复 Deepgram duration 字段读取路径问题

- **2025-12-23**（第一次更新）：
  - 实现 YouTube 字幕优先提取功能
  - 添加 Cookies 支持（通过 Secret Manager 挂载）
  - 修复 cookies 权限问题（复制到 /tmp 并设置可写权限）
  - 修复临时目录路径（使用 /tmp/youtube 而非 /app/tmp/youtube）
  - 使用 `-f bestaudio/best` 提高格式兼容性
  - Dockerfile 更新 yt-dlp 到最新版本（--upgrade）
  - 测试验证：有字幕视频（Rick Astley）和无字幕视频（Me at the zoo）均成功
