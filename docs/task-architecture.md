# 任务处理架构

本文档描述后端服务的任务处理架构，包括流程、组件和优化建议。

## 一、架构概览

```
                                    ┌─────────────────────────────────────────────────────────┐
                                    │                      API 层                              │
                                    │              POST /api/tasks (创建)                      │
                                    │              GET /api/tasks/:id (查询)                   │
                                    └─────────────────────────┬───────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     TasksService                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ 体验限制校验  │  │ 余额检查     │  │ 并发限制     │  │ 创建记录     │  │ 入队处理     │       │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┬───────────────────────────────────┘
                                                              │
                              ┌────────────────────────────────┼────────────────────────────────┐
                              │                                │                                │
                              ▼                                ▼                                │
                    ┌──────────────────┐            ┌──────────────────┐                        │
                    │ Redis 队列模式    │            │ 同步模式          │                        │
                    │ (BullMQ)         │            │ (setImmediate)   │                        │
                    └────────┬─────────┘            └────────┬─────────┘                        │
                             │                               │                                  │
                             └───────────────┬───────────────┘                                  │
                                             ▼                                                  │
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  TaskProcessorService                                            │
│                                                                                                  │
│    ┌─────────────────────────────────────────────────────────────────────────────────────┐      │
│    │                           根据 source_type 路由                                      │      │
│    │                                                                                      │      │
│    │   ┌─────────────────────────────┐      ┌─────────────────────────────┐              │      │
│    │   │ YouTube (source_type=youtube)│      │ 上传音频 (source_type=upload)│              │      │
│    │   │                              │      │                              │              │      │
│    │   │  ┌───────────────────────┐  │      │  ┌───────────────────────┐  │              │      │
│    │   │  │ Supadata API          │  │      │  │ Deepgram API          │  │              │      │
│    │   │  │ - 优先现成字幕 (免费)  │  │      │  │ - Nova-2 模型          │  │              │      │
│    │   │  │ - AI 生成 (计费)       │  │      │  │ - 说话人识别           │  │              │      │
│    │   │  └───────────┬───────────┘  │      │  │ - 语言检测             │  │              │      │
│    │   │              │              │      │  └───────────┬───────────┘  │              │      │
│    │   │              ▼              │      │              │              │              │      │
│    │   │  ┌───────────────────────┐  │      │              │              │              │      │
│    │   │  │ OpenAI LLM 合并       │  │      │              │              │              │      │
│    │   │  │ (GPT-5.2)             │  │      │              │              │              │      │
│    │   │  └───────────┬───────────┘  │      │              │              │              │      │
│    │   │              │              │      │              │              │              │      │
│    │   └──────────────┼──────────────┘      └──────────────┼──────────────┘              │      │
│    │                  │                                    │                             │      │
│    └──────────────────┼────────────────────────────────────┼─────────────────────────────┘      │
│                       │                                    │                                    │
│                       └────────────────┬───────────────────┘                                    │
│                                        ▼                                                        │
│    ┌─────────────────────────────────────────────────────────────────────────────────────┐      │
│    │                          TranscriptsService                                          │      │
│    │   - 生成 SRT/VTT 格式                                                                │      │
│    │   - 上传到 R2 存储                                                                   │      │
│    │   - 保存到 Supabase                                                                  │      │
│    └─────────────────────────────────────────────────────────────────────────────────────┘      │
│                                        │                                                        │
│                                        ▼                                                        │
│    ┌─────────────────────────────────────────────────────────────────────────────────────┐      │
│    │                          BillingService                                              │      │
│    │   - 扣除余额（付费用户）                                                              │      │
│    │   - 记录体验使用（体验用户）                                                          │      │
│    └─────────────────────────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 二、任务状态机

```
                    创建任务
                       │
                       ▼
                 ┌──────────┐
                 │ PENDING  │
                 └────┬─────┘
                      │
            开始处理 │
                      ▼
                 ┌──────────┐
         ┌───────│PROCESSING│───────┐
         │       └──────────┘       │
         │                          │
    成功 │                          │ 失败/超时
         ▼                          ▼
   ┌──────────┐               ┌──────────┐
   │SUCCEEDED │               │  FAILED  │
   └──────────┘               └──────────┘
```

### 状态说明

| 状态 | 说明 | 触发条件 |
|------|------|----------|
| `pending` | 等待处理 | 任务创建成功 |
| `processing` | 处理中 | 开始转录处理 |
| `succeeded` | 成功 | 转录完成并保存 |
| `failed` | 失败 | 处理出错或超时 |

## 三、处理模式对比

### 3.1 Redis 队列模式（生产环境）

```typescript
// 入队
await this.tasksQueue.add('transcribe', jobData, {
  priority: priority === Priority.PAID ? 1 : 10,  // 付费优先
  attempts: 3,                                      // 重试 3 次
  backoff: { type: 'exponential', delay: 5000 },  // 指数退避
});
```

**优点**：
- 任务持久化，服务重启不丢失
- 支持优先级调度
- 自动重试机制
- 可水平扩展 Worker

**缺点**：
- 需要维护 Redis 服务
- 增加系统复杂度

### 3.2 同步模式（开发环境）

```typescript
// 直接处理
setImmediate(async () => {
  await this.taskProcessorService.processTask(jobData);
});
```

**优点**：
- 无需额外依赖
- 部署简单

**缺点**：
- 服务重启任务丢失
- 无法水平扩展

## 四、转录提供者

### 4.1 YouTube 视频 → Supadata + OpenAI

```
YouTube URL
     │
     ▼
Supadata API (mode=auto)
     │
     ├─ 有现成字幕 ──► 直接返回 (cost=0)
     │
     └─ 无字幕 ──► AI 生成
                    │
                    ▼
              异步任务轮询
              (最多 10 分钟)
                    │
                    ▼
              OpenAI LLM 合并
              (GPT-5.2)
                    │
                    ▼
              返回结果 (cost=分钟数)
```

### 4.2 上传音频 → Deepgram

```
音频 URL (R2)
     │
     ▼
Deepgram API
  - model: nova-2
  - diarize: true (说话人识别)
  - detect_language: true
     │
     ▼
返回结果 (cost=分钟数)
```

## 五、核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| TasksController | `src/modules/tasks/tasks.controller.ts` | API 端点 |
| TasksService | `src/modules/tasks/tasks.service.ts` | 创建任务、查询状态 |
| TaskProcessorService | `src/modules/tasks/task-processor.service.ts` | 核心处理逻辑 |
| TasksProcessor | `src/modules/tasks/tasks.processor.ts` | BullMQ Worker |
| TaskCleanupService | `src/modules/tasks/task-cleanup.service.ts` | 故障恢复 |
| SupadataService | `src/providers/supadata/supadata.service.ts` | YouTube 转录 |
| DeepgramService | `src/providers/deepgram/deepgram.service.ts` | 音频转录 |
| OpenAIService | `src/providers/openai/openai.service.ts` | LLM 合并 |
| TranscriptsService | `src/modules/transcripts/transcripts.service.ts` | 保存结果 |
| BillingService | `src/modules/billing/billing.service.ts` | 计费扣款 |

## 六、故障恢复机制

```typescript
// task-cleanup.service.ts
@Cron(CronExpression.EVERY_5_MINUTES)
async handleCron() {
  // 查找 PROCESSING 超过 10 分钟的任务
  const stuckTasks = await findStuckTasks(10 * 60 * 1000);

  // 标记为失败
  await markTasksFailed(stuckTasks, '任务处理超时');
}
```

**触发条件**：
- 任务状态为 `processing`
- `updated_at` 距今超过 10 分钟

## 七、计费规则

| 场景 | 计费 |
|------|------|
| YouTube 现成字幕 | 免费 (cost_minutes = 0) |
| YouTube AI 生成 | ceil(duration / 60) 分钟 |
| 上传音频 | ceil(duration / 60) 分钟 |
| 体验用户 | 免费，限 1 次，≤30 分钟 |

## 八、并发控制

```typescript
// 同一用户/设备最多 1 个进行中任务
const pendingTasks = await supabase
  .from('tasks')
  .select('id')
  .in('status', ['pending', 'processing'])
  .or(`user_id.eq.${userId},anon_id.eq.${anonId}`);

if (pendingTasks.length > 0) {
  throw new BadRequestException('已有任务在处理中');
}
```

---

# 九、优化空间分析

## 9.1 性能优化

### 问题 1：Supadata 轮询效率低

**现状**：每 5 秒轮询一次，最多 120 次（10 分钟）

```typescript
// supadata.service.ts
private async pollJob(jobId: string, ..., intervalMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await this.sleep(intervalMs);  // 固定间隔
    // ...
  }
}
```

**优化建议**：

1. **指数退避轮询**：初始 2 秒，逐渐增加到 10 秒
   ```typescript
   const interval = Math.min(2000 * Math.pow(1.5, attempt), 10000);
   ```

2. **Webhook 回调**：如果 Supadata 支持，使用 Webhook 替代轮询

### 问题 2：LLM 合并无缓存

**现状**：相同内容每次都调用 OpenAI API

**优化建议**：
- 对于相同的 YouTube 视频，缓存 LLM 合并结果
- 使用 Redis 或 Supabase 存储缓存

### 问题 3：SRT/VTT 生成在同步流程中

**现状**：生成文件格式和上传 R2 都在主流程

**优化建议**：
- 将 SRT/VTT 生成作为异步任务
- 或使用流式上传减少内存占用

---

## 9.2 可靠性优化

### 问题 1：同步模式任务可能丢失

**现状**：`setImmediate` 处理，服务重启丢失任务

**优化建议**：
- 启动时扫描 `pending` 状态任务，重新入队处理
- 添加启动恢复逻辑

### 问题 2：OpenAI 失败无降级

**现状**：OpenAI 不可用直接抛错

```typescript
if (!this.openAIService.isAvailable()) {
  throw new Error('OpenAI service not available');
}
```

**优化建议**：
- 考虑保留简单的规则合并作为降级方案
- 或者接入其他 LLM 服务作为备选

### 问题 3：单点故障风险

**现状**：依赖多个第三方服务（Supadata、Deepgram、OpenAI）

**优化建议**：
- 实现熔断器模式（Circuit Breaker）
- 添加服务健康检查接口

---

## 9.3 成本优化

### 问题 1：LLM 合并成本

**现状**：所有 Supadata 结果都经过 LLM 处理

**优化建议**：
- 仅对碎片化严重的结果使用 LLM
- 设定阈值：如果 segments 平均长度 > 50 字符，跳过 LLM

```typescript
const avgLength = segments.reduce((a, s) => a + s.text.length, 0) / segments.length;
if (avgLength > 50) {
  return segments;  // 跳过 LLM 合并
}
```

### 问题 2：R2 存储未清理

**现状**：所有转录文件永久保存

**优化建议**：
- 设置 R2 生命周期策略
- 体验用户文件 7 天后删除
- 付费用户可选保留时长

---

## 9.4 功能增强

### 建议 1：进度反馈

**现状**：只有最终状态，无进度信息

**优化建议**：
```typescript
// 添加 progress 字段
interface Task {
  progress?: {
    stage: 'downloading' | 'transcribing' | 'merging' | 'saving';
    percent: number;
  };
}
```

### 建议 2：任务取消

**现状**：无法取消进行中的任务

**优化建议**：
- 添加 `DELETE /api/tasks/:id` 端点
- BullMQ 支持 `job.remove()`

### 建议 3：批量处理

**现状**：一次只能提交一个任务

**优化建议**：
- 支持 `POST /api/tasks/batch`
- 一次提交多个 URL

### 建议 4：Webhook 通知

**现状**：需要客户端轮询状态

**优化建议**：
- 任务完成后主动推送通知
- 支持配置 Webhook URL

---

## 9.5 代码质量

### 问题 1：重复代码

**现状**：`task-processor.service.ts` 和 `supadata.service.ts` 有相似逻辑

**优化建议**：
- 抽取公共的 segment 处理逻辑

### 问题 2：错误处理不统一

**现状**：不同服务返回不同格式的错误

**优化建议**：
- 定义统一的 `TranscriptionError` 类
- 统一错误码体系

### 问题 3：缺少单元测试

**优化建议**：
- 为 TaskProcessorService 添加测试
- Mock 第三方服务

---

## 十、优化优先级建议

| 优先级 | 优化项 | 预期收益 | 工作量 |
|--------|--------|----------|--------|
| P0 | 同步模式启动恢复 | 防止任务丢失 | 低 |
| P0 | OpenAI 降级方案 | 提高可用性 | 中 |
| P1 | 指数退避轮询 | 减少 API 调用 | 低 |
| P1 | LLM 合并条件判断 | 节省成本 | 低 |
| P2 | 进度反馈 | 改善用户体验 | 中 |
| P2 | 任务取消功能 | 改善用户体验 | 中 |
| P3 | Webhook 通知 | 减少轮询压力 | 中 |
| P3 | R2 生命周期策略 | 节省存储成本 | 低 |

---

## 更新日志

- **2025-12-24**：创建文档，完成架构梳理和优化分析
