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

## 环境变量配置

在 Cloud Run 控制台或使用 gcloud 命令配置以下环境变量：

| 变量名 | 说明 |
|--------|------|
| `NODE_ENV` | 设置为 `production` |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key |
| `R2_BUCKET` | Cloudflare R2 存储桶名称 |
| `R2_ACCESS_KEY` | R2 访问密钥 |
| `R2_SECRET_KEY` | R2 密钥 |
| `R2_ENDPOINT` | R2 端点 URL |
| `REDIS_URL` | Redis 连接 URL |
| `DEEPGRAM_API_KEY` | Deepgram API 密钥 |
| `STRIPE_SECRET_KEY` | Stripe 密钥 |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 密钥 |

## 部署方式

### 方式一：手动部署

```bash
# 1. 构建 Docker 镜像
docker build -t gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest .

# 2. 推送镜像到 Container Registry
docker push gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest

# 3. 部署到 Cloud Run
gcloud run deploy audio-to-text-backend \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --platform managed \
  --region asia-east1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars "NODE_ENV=production,SUPABASE_URL=xxx,..."
```

### 方式二：使用 Cloud Build (推荐)

```bash
# 提交构建
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=asia-east1
```

### 方式三：设置 CI/CD 自动部署

1. 进入 Cloud Build 控制台
2. 创建触发器 → 连接 GitHub 仓库
3. 选择 `cloudbuild.yaml` 作为构建配置
4. 设置触发条件（如：推送到 main 分支）

## 配置 Secrets（推荐）

使用 Google Secret Manager 管理敏感信息：

```bash
# 创建 secrets
gcloud secrets create SUPABASE_SERVICE_ROLE_KEY --data-file=-
gcloud secrets create DEEPGRAM_API_KEY --data-file=-
gcloud secrets create STRIPE_SECRET_KEY --data-file=-

# 授予 Cloud Run 访问权限
gcloud secrets add-iam-policy-binding SUPABASE_SERVICE_ROLE_KEY \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor"

# 在 Cloud Run 中使用 secrets
gcloud run deploy audio-to-text-backend \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --set-secrets="SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest"
```

## Redis 配置

Cloud Run 需要外部 Redis 服务。推荐选项：

1. **Upstash Redis** (推荐，有免费额度，Serverless)
   - https://upstash.com/
   - 支持 REST API，适合 Serverless 环境

2. **Redis Cloud**
   - https://redis.com/cloud/

3. **Google Cloud Memorystore**
   - 需要 VPC 连接器

## Worker 部署

Worker 进程需要单独部署。创建另一个 Cloud Run 服务：

```bash
# 修改启动命令为 worker
gcloud run deploy audio-to-text-worker \
  --image gcr.io/YOUR_PROJECT_ID/audio-to-text-backend:latest \
  --platform managed \
  --region asia-east1 \
  --memory 1Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 5 \
  --command "node" \
  --args "dist/worker.js" \
  --no-allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,..."
```

## 验证部署

```bash
# 获取服务 URL
gcloud run services describe audio-to-text-backend --region=asia-east1 --format='value(status.url)'

# 测试健康检查
curl https://YOUR_SERVICE_URL/api/health
```

## 监控与日志

```bash
# 查看日志
gcloud run logs read --service=audio-to-text-backend --region=asia-east1

# 实时日志
gcloud run logs tail --service=audio-to-text-backend --region=asia-east1
```

## 成本优化建议

1. 设置 `min-instances=0` 以在无请求时缩容到零
2. 使用 CPU Throttling（默认开启）
3. 合理设置内存和 CPU 限制
4. 使用 Container Registry 的生命周期策略清理旧镜像

## 故障排查

### 容器启动失败
```bash
gcloud run logs read --service=audio-to-text-backend --region=asia-east1 --limit=50
```

### 内存不足
增加内存限制：`--memory 1Gi`

### 冷启动慢
- 设置 `min-instances=1`
- 优化 Docker 镜像大小
- 减少启动时的依赖初始化
