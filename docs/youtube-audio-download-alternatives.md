# YouTube 音频下载替代方案

本文档调研 yt-dlp 的替代方案，用于 YouTube 音频下载 → R2 上传 → Deepgram 转录流程。

## 当前架构（已弃用）

```
YouTube URL
     │
     ▼
yt-dlp 下载音频
(需要 Cookies + ffmpeg)
     │
     ▼
上传到 R2
     │
     ▼
Deepgram 转录
     │
     ▼
返回结果
```

**弃用原因**：
- 需要维护 yt-dlp 版本（YouTube 频繁更新）
- 需要配置 Cookies（绕过登录验证）
- Cloud Run 环境部署复杂

---

## 替代方案对比

### 方案 1：Cobalt（推荐自建）

[GitHub: imputnet/cobalt](https://github.com/imputnet/cobalt)

**简介**：开源媒体下载服务，支持 YouTube、TikTok、Twitter 等平台

**API 使用**：

```bash
# 请求
POST https://your-cobalt-instance/
Content-Type: application/json

{
  "url": "https://youtube.com/watch?v=xxx",
  "downloadMode": "audio",
  "audioFormat": "mp3",
  "audioBitrate": "128"
}

# 响应
{
  "status": "tunnel",
  "url": "https://your-cobalt-instance/tunnel?..."
}
```

**参数说明**：

| 参数 | 可选值 | 默认值 |
|------|--------|--------|
| `downloadMode` | auto / audio / mute | auto |
| `audioFormat` | best / mp3 / ogg / wav / opus | mp3 |
| `audioBitrate` | 320 / 256 / 128 / 96 / 64 / 8 | 128 |

**部署方式**：
- Docker 自建（推荐）
- 公共实例 api.cobalt.tools（有频率限制，需 Turnstile 验证）

**优点**：
- 开源免费
- 支持多平台
- API 简洁
- 无需 Cookies

**缺点**：
- 需要自建服务
- 依赖上游稳定性

---

### 方案 2：RapidAPI 第三方服务

RapidAPI 上有多个 YouTube 下载 API，常见的有：

#### 2.1 YouTube MP3 Downloader

```bash
# 请求示例
GET https://youtube-mp3-downloader2.p.rapidapi.com/ytmp3/ytmp3/{videoId}
X-RapidAPI-Key: your-api-key
X-RapidAPI-Host: youtube-mp3-downloader2.p.rapidapi.com
```

**定价**（参考）：
- Free: 100 请求/月
- Basic: $9.99/月，1000 请求
- Pro: $29.99/月，5000 请求

#### 2.2 YouTube to MP3

```bash
# 请求示例
POST https://youtube-to-mp315.p.rapidapi.com/download
Content-Type: application/json

{
  "url": "https://youtube.com/watch?v=xxx",
  "quality": "128"
}
```

**优点**：
- 即插即用
- 无需维护基础设施

**缺点**：
- 按请求计费
- 可靠性不稳定（依赖第三方）
- 可能随时下架

---

### 方案 3：云函数 + yt-dlp

在 Cloud Functions 中运行 yt-dlp，与主服务分离。

```
YouTube URL
     │
     ▼
Cloud Function (yt-dlp)
     │
     ▼
音频 URL (临时)
     │
     ▼
主服务下载 → R2 → Deepgram
```

**优点**：
- 隔离复杂依赖
- 可独立扩展
- 使用原生 yt-dlp

**缺点**：
- 仍需维护 yt-dlp
- 需要配置 Cookies
- 增加系统复杂度

---

### 方案 4：保持现状（Supadata）

当前使用 Supadata API 直接获取转录，无需下载音频。

```
YouTube URL
     │
     ▼
Supadata API
     │
     ├─ 现成字幕 (免费)
     │
     └─ AI 生成 (计费)
     │
     ▼
OpenAI LLM 合并
     │
     ▼
返回结果
```

**优点**：
- 无需维护下载逻辑
- API 简单
- 支持多平台

**缺点**：
- AI 生成质量参差
- 无法获取原始音频
- 依赖第三方

---

## 完整流程图（yt-dlp 替代方案 + Deepgram）

如果需要使用 Deepgram 替代 Supadata AI 生成，推荐架构：

```
                        YouTube URL
                             │
                             ▼
                    ┌────────────────┐
                    │  尝试获取字幕   │
                    │  (Supadata)    │
                    └───────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             │             ▼
         有现成字幕          │        无字幕
        (isGenerated=false) │
              │             │             │
              ▼             │             ▼
         直接返回            │    ┌───────────────┐
                            │    │ 下载音频       │
                            │    │ (Cobalt API)  │
                            │    └───────┬───────┘
                            │            │
                            │            ▼
                            │    ┌───────────────┐
                            │    │ 上传到 R2     │
                            │    └───────┬───────┘
                            │            │
                            │            ▼
                            │    ┌───────────────┐
                            │    │ Deepgram 转录 │
                            │    │ (说话人识别)   │
                            │    └───────┬───────┘
                            │            │
                            └────────────┼─────────
                                         │
                                         ▼
                                    返回结果
```

### 代码实现思路

```typescript
// task-processor.service.ts
async processYouTube(url: string, language?: string): Promise<TranscriptResult> {
  // 1. 优先尝试获取现成字幕
  const nativeResult = await this.supadataService.getNativeTranscript(url, language);
  if (nativeResult) {
    return nativeResult;  // 免费，直接返回
  }

  // 2. 无字幕，使用 Cobalt 下载音频
  const audioUrl = await this.cobaltService.downloadAudio(url);

  // 3. 上传到 R2
  const r2Url = await this.r2Service.uploadFromUrl(audioUrl, `youtube/${videoId}.mp3`);

  // 4. Deepgram 转录
  const result = await this.deepgramService.transcribeUrlSync(r2Url, { language });

  return {
    segments: this.extractSegments(result),
    duration: result.duration,
    language: result.detected_language,
    isGenerated: true,
  };
}
```

---

## 建议

| 场景 | 推荐方案 |
|------|----------|
| 当前生产环境 | **保持 Supadata**，稳定且无需维护 |
| 需要高质量转录 | **Cobalt 自建 + Deepgram**，说话人识别更好 |
| 快速验证 | **RapidAPI 服务**，但长期不推荐 |
| 已有 yt-dlp 经验 | **Cloud Function 隔离**，降低主服务复杂度 |

---

## 参考资源

- [Cobalt GitHub](https://github.com/imputnet/cobalt)
- [Cobalt API 文档](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
- [RapidAPI YouTube APIs](https://rapidapi.com/search/youtube%20download)
- [yt-dlp GitHub](https://github.com/yt-dlp/yt-dlp)

---

## 更新日志

- **2025-12-24**：创建文档，调研 yt-dlp 替代方案
