-- ============================================
-- AI 音视频转录 MVP 数据库表结构
-- 在 Supabase SQL Editor 中执行此脚本
-- ============================================

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. 用户表 (users)
-- 注意: Supabase Auth 已经有 auth.users 表
-- 这里创建一个 public.users 表存储额外信息
-- ============================================
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'email', -- email | google
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- RLS 策略
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING (auth.uid() = id);

-- ============================================
-- 2. 匿名 Token 表 (anon_tokens)
-- 用于追踪匿名体验用户
-- ============================================
CREATE TABLE IF NOT EXISTS public.anon_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    anon_id TEXT NOT NULL UNIQUE,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    used_trial BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_anon_tokens_anon_id ON public.anon_tokens(anon_id);

-- RLS 策略 (后端使用 service_role 访问，无需开放)
ALTER TABLE public.anon_tokens ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 3. 体验使用记录表 (trial_usages)
-- ============================================
CREATE TABLE IF NOT EXISTS public.trial_usages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    anon_id TEXT REFERENCES public.anon_tokens(anon_id),
    user_id UUID REFERENCES public.users(id),
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trial_usages_anon_id ON public.trial_usages(anon_id);
CREATE INDEX IF NOT EXISTS idx_trial_usages_user_id ON public.trial_usages(user_id);

-- RLS 策略
ALTER TABLE public.trial_usages ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 4. 余额表 (balances)
-- ============================================
CREATE TABLE IF NOT EXISTS public.balances (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    minutes_balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS 策略
ALTER TABLE public.balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own balance" ON public.balances
    FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 5. 支付记录表 (payments)
-- ============================================
CREATE TABLE IF NOT EXISTS public.payments (
    id TEXT PRIMARY KEY, -- Stripe event_id，用于幂等
    user_id UUID NOT NULL REFERENCES public.users(id),
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT,
    event_type TEXT NOT NULL,
    minutes_delta NUMERIC(10, 2) NOT NULL DEFAULT 0,
    raw_event JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON public.payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_customer_id ON public.payments(stripe_customer_id);

-- RLS 策略
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments" ON public.payments
    FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 6. 任务表 (tasks)
-- ============================================
CREATE TYPE task_status AS ENUM ('pending', 'processing', 'succeeded', 'failed');
CREATE TYPE source_type AS ENUM ('upload', 'url', 'youtube');
CREATE TYPE task_priority AS ENUM ('paid', 'free');

CREATE TABLE IF NOT EXISTS public.tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id),
    anon_id TEXT,
    task_type TEXT NOT NULL DEFAULT 'transcription',
    source_type source_type NOT NULL,
    source_url TEXT NOT NULL,
    size_bytes BIGINT,
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    priority task_priority NOT NULL DEFAULT 'free',
    status task_status NOT NULL DEFAULT 'pending',
    engine TEXT NOT NULL DEFAULT 'deepgram',
    engine_config JSONB,
    params JSONB,
    duration_sec NUMERIC(10, 2),
    cost_minutes NUMERIC(10, 2),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON public.tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_anon_id ON public.tasks(anon_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON public.tasks(created_at DESC);

-- RLS 策略
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tasks" ON public.tasks
    FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 7. 转录结果表 (transcripts)
-- ============================================
CREATE TABLE IF NOT EXISTS public.transcripts (
    task_id UUID PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
    segments JSONB NOT NULL DEFAULT '[]',
    raw_response JSONB,
    raw_url TEXT,
    srt_url TEXT,
    vtt_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS 策略
ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transcripts" ON public.transcripts
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.tasks
            WHERE tasks.id = transcripts.task_id
            AND tasks.user_id = auth.uid()
        )
    );

-- ============================================
-- 8. 触发器：自动更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at
    BEFORE UPDATE ON public.tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 9. 触发器：新用户注册时自动创建 users 记录
-- ============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, email, provider)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_app_meta_data->>'provider', 'email')
    );

    -- 同时创建余额记录
    INSERT INTO public.balances (user_id, minutes_balance)
    VALUES (NEW.id, 0);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user();

-- ============================================
-- 完成提示
-- ============================================
-- 执行完毕后，请在 Supabase Dashboard 中确认：
-- 1. 所有表已创建
-- 2. RLS 策略已启用
-- 3. 触发器已创建
