# YouTube 转录流程

本文档描述了后端服务处理 YouTube 视频转录的完整流程。

## 概述

系统当前采用 **Supadata API** 处理 YouTube 视频转录：

1. **优先方案**：通过 Supadata 获取现成字幕（免费）
2. **备用方案**：Supadata AI 生成转录（按分钟计费）

## 当前流程图（Supadata 方案）

```
YouTube URL
    │
    ▼
┌─────────────────────────────┐
│   Supadata API (mode=auto)  │
│   自动选择最佳方案           │
└─────────────┬───────────────┘
              │
      ┌───────┴───────┐
      │               │
      ▼               ▼
   有现成字幕      无现成字幕
 (isGenerated=     (isGenerated=
    false)            true)
      │               │
      ▼               ▼
   保存结果      ┌───────────────────┐
   cost=0       │ Supadata AI 生成   │
                │ (异步任务轮询)      │
                └─────────┬─────────┘
                          │
                          ▼
                      保存结果
                  cost=ceil(duration/60)
```

**相关代码**：`src/providers/supadata/supadata.service.ts`

---

## 旧流程图（yt-dlp + Deepgram 方案，已弃用）

> 以下流程已被 Supadata 方案替代，保留供参考。

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

## 当前方案详细说明（Supadata）

### Supadata API 介绍

**文件**：`src/providers/supadata/supadata.service.ts`

Supadata 是一个第三方 API 服务，专门用于获取 YouTube 等平台的视频转录。

### 工作模式

| 模式 | 说明 | 费用 |
|------|------|------|
| `auto` | 自动选择：优先现成字幕，无字幕时 AI 生成 | 现成字幕免费，AI 生成 2 credits/分钟 |
| `native` | 仅获取现成字幕，无字幕则报错 | 1 credit |
| `generate` | 强制 AI 生成转录 | 2 credits/分钟 |

### 多语言支持

- 前端可通过 `params.language` 指定字幕语言
- 支持的语言代码：`zh`（中文）、`en`（英文）、`ja`（日文）等

### 异步任务处理

当需要 AI 生成转录时，Supadata 返回 `202 Accepted` 和 `jobId`，需要轮询获取结果：
- 轮询间隔：5 秒
- 最大等待：10 分钟（120 次轮询）

### 代码示例

```typescript
// 自动模式（推荐）
const result = await this.supadataService.getTranscript(videoUrl, language, 'auto');

// 结果判断
if (result.isGenerated) {
  // AI 生成，需要计费
  costMinutes = Math.ceil(result.duration / 60);
} else {
  // 现成字幕，免费
  costMinutes = 0;
}
```

### 优点

- 无需维护 yt-dlp、Cookies 等基础设施
- 支持多平台（YouTube、TikTok、Instagram 等）
- API 简单易用

### 缺点

- AI 生成质量参差不齐（当前主要问题）
- 依赖第三方服务稳定性
- 无法获取说话人信息

### Segments 合并

Supadata AI 生成的转录返回逐词级别的 chunks，需要后处理合并为完整句子。

详见：[Segments 合并规则](./segment-merge-rules.md)

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/providers/supadata/supadata.service.ts` | Supadata API 服务（当前方案） |
| `src/modules/tasks/task-processor.service.ts` | 任务处理核心逻辑 |
| `src/providers/youtube/youtube.service.ts` | YouTube URL 解析、视频信息获取 |
| `src/providers/youtube/youtube-transcript.service.ts` | YouTube 字幕提取服务（旧方案） |
| `src/providers/youtube/youtube-downloader.service.ts` | yt-dlp 音频下载服务（旧方案） |
| `src/providers/deepgram/deepgram.service.ts` | Deepgram 转录服务（用于上传音频） |

## 费用说明

### 当前方案（Supadata）

| 方案 | 费用 |
|------|------|
| 现成字幕 (isGenerated=false) | 免费 (cost_minutes = 0) |
| AI 生成 (isGenerated=true) | 按时长计费 (cost_minutes = ceil(duration/60)) |

### 旧方案（yt-dlp + Deepgram）

| 方案 | 费用 |
|------|------|
| YouTube 字幕提取 | 免费 (cost_minutes = 0) |
| Deepgram 转录 | 按时长计费 (cost_minutes = ceil(duration/60)) |

---

## 旧方案详细说明（yt-dlp + Deepgram，已弃用）

> 以下内容为历史记录，当前已被 Supadata 方案替代。

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

#### 2.2 上传到 R2

音频下载后上传到 Cloudflare R2 存储，生成可访问的 URL。

#### 2.3 Deepgram 转录

**文件**：`src/providers/deepgram/deepgram.service.ts`

将音频 URL 提交给 Deepgram API 进行转录。

### Cookies 配置（旧方案需要）

YouTube 会检测数据中心 IP（如 Cloud Run），对可疑请求要求登录验证。Cookies 可以绕过这个限制。

**配置步骤**：

1. 使用浏览器扩展导出 YouTube cookies
2. 存储到 Secret Manager：`gcloud secrets create YOUTUBE_COOKIES --data-file=cookies.txt`
3. Cloud Run 部署配置挂载 secrets

---

## 更新日志

- **2025-12-23**（第三次更新）：
  - 集成 Supadata API 替代 yt-dlp 方案
  - 简化架构，无需维护 yt-dlp 和 Cookies

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
