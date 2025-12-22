export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  r2: {
    bucket: process.env.R2_BUCKET,
    accessKey: process.env.R2_ACCESS_KEY,
    secretKey: process.env.R2_SECRET_KEY,
    endpoint: process.env.R2_ENDPOINT,
    publicUrl: process.env.R2_PUBLIC_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    webhookSecret: process.env.DEEPGRAM_WEBHOOK_SECRET,
  },

  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY,
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  sentry: {
    dsn: process.env.SENTRY_DSN,
  },

  // 业务配置
  trial: {
    maxDurationMinutes: 30, // 体验用户单次任务最大时长
    maxUsageCount: 1, // 体验用户最大任务数
  },

  task: {
    pollIntervalSeconds: 5, // 默认轮询间隔
  },
});
