# Google Cloud Run 部署指南

## 前置要求

1. 安装 [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
2. 创建 GCP 项目并启用以下 API：
   - Cloud Run API
   - Cloud Build API
   - Container Registry API
3. 配置 gcloud CLI：
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

## 两种运行模式

### 模式一：同步模式（默认，无需 Redis）

适合初期测试和小规模使用。转录任务在 API 服务中直接处理。

**优点：**
- 部署简单，无需额外服务
- 成本低

**缺点：**
- 长时间任务可能超时
- 无法并发处理多个任务

### 模式二：队列模式（需要 Redis + Worker）

适合生产环境和大规模使用。任务通过 Redis 队列异步处理。

**优点：**
- 支持长时间任务
- 可扩展，支持多 Worker
- 任务重试机制

**缺点：**
- 需要配置 Redis
- 需要部署额外的 Worker 服务

---

## 快速开始：同步模式部署

### 1. 配置环境变量

在 Cloud Run 控制台或使用 gcloud 配置以下环境变量：

| 变量名 | 说明 |
|--------|------|
| `NODE_ENV` | 设置为 `production` |
| `REDIS_ENABLED` | 设置为 `false`（同步模式） |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key |
| `R2_BUCKET` | Cloudflare R2 存储桶名称 |
| `R2_ACCESS_KEY` | R2 访问密钥 |
| `R2_SECRET_KEY` | R2 密钥 |
| `R2_ENDPOINT` | R2 端点 URL |
| `DEEPGRAM_API_KEY` | Deepgram API 密钥 |

### 2. 部署

```bash
gcloud builds submit --config cloudbuild.yaml
```

这会部署一个单独的 API 服务，不需要 Redis。

---

## 升级到队列模式

当任务量增加，需要升级到队列模式时：

### 1. 创建 Upstash Redis

1. 访问 https://console.upstash.com/
2. 点击 **Create Database**
3. 选择区域：`Asia Pacific (Tokyo)` 或 `Asia Pacific (Singapore)`
4. 创建后，复制 **Redis URL**

### 2. 使用队列模式配置部署

```bash
gcloud builds submit --config cloudbuild-with-worker.yaml \
  --substitutions=_REDIS_URL="rediss://default:xxx@xxx.upstash.io:6379"
```

这会同时部署：
- **audio-to-text-backend**：API 服务
- **audio-to-text-worker**：Worker 服务

---

## 手动部署

### 同步模式（无 Redis）

```bash
# 1. 构建 Docker 镜像
docker build -t gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest .

# 2. 推送镜像
docker push gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest

# 3. 部署到 Cloud Run
gcloud run deploy audio-to-text-backend \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --platform managed \
  --region asia-east1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --set-env-vars "NODE_ENV=production,REDIS_ENABLED=false,SUPABASE_URL=xxx,..."
```

### 队列模式（需要 Redis）

```bash
# 部署 API 服务
gcloud run deploy audio-to-text-backend \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --platform managed \
  --region asia-east1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --set-env-vars "NODE_ENV=production,REDIS_ENABLED=true,REDIS_URL=xxx,..."

# 部署 Worker 服务
gcloud run deploy audio-to-text-worker \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --platform managed \
  --region asia-east1 \
  --no-allow-unauthenticated \
  --memory 1Gi \
  --cpu 2 \
  --min-instances 1 \
  --command "node" \
  --args "dist/worker.js" \
  --set-env-vars "NODE_ENV=production,REDIS_ENABLED=true,REDIS_URL=xxx,..."
```

---

## 服务架构

### 同步模式
```
┌─────────────────┐
│   Cloud Run     │
│   API 服务      │──────▶ Deepgram
│ (同步处理任务)  │
└─────────────────┘
```

### 队列模式
```
┌─────────────────┐     ┌─────────────────┐
│   Cloud Run     │     │   Cloud Run     │
│   API 服务      │────▶│   Worker 服务   │──────▶ Deepgram
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
    ┌─────────────────────────────────┐
    │          Upstash Redis          │
    │         (任务队列)              │
    └─────────────────────────────────┘
```

---

## 配置 Secrets（推荐）

使用 Google Secret Manager 管理敏感信息：

```bash
# 创建 secrets
echo -n "your-api-key" | gcloud secrets create DEEPGRAM_API_KEY --data-file=-

# 授予 Cloud Run 访问权限
gcloud secrets add-iam-policy-binding DEEPGRAM_API_KEY \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor"

# 在 Cloud Run 中使用 secrets
gcloud run deploy audio-to-text-backend \
  --set-secrets="DEEPGRAM_API_KEY=DEEPGRAM_API_KEY:latest"
```

---

## 验证部署

```bash
# 获取服务 URL
gcloud run services describe audio-to-text-backend --region=asia-east1 --format='value(status.url)'

# 测试 API
curl https://YOUR_SERVICE_URL/api
```

---

## 监控与日志

```bash
# 查看日志
gcloud run logs read --service=audio-to-text-backend --region=asia-east1

# 实时日志
gcloud run logs tail --service=audio-to-text-backend --region=asia-east1
```

---

## 成本优化建议

1. **同步模式**：设置 `min-instances=0`，无请求时自动缩容到零
2. **队列模式**：Worker 设置 `min-instances=1` 保持响应性
3. 使用 Container Registry 生命周期策略清理旧镜像

---

## 故障排查

### 容器启动失败
```bash
gcloud run logs read --service=audio-to-text-backend --region=asia-east1 --limit=50
```

### 任务处理超时
- 同步模式下，增加 `--timeout` 值（最大 3600s）
- 或升级到队列模式

### Redis 连接失败
- 检查 `REDIS_URL` 格式是否正确
- 确保使用 `rediss://`（带 SSL）而不是 `redis://`
