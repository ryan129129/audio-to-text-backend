-- ============================================
-- 辅助函数
-- ============================================

-- ============================================
-- 1. 安全扣减余额函数（带乐观锁）
-- 返回 true 表示扣减成功，false 表示失败
-- ============================================
CREATE OR REPLACE FUNCTION deduct_balance(
    p_user_id UUID,
    p_minutes NUMERIC
)
RETURNS BOOLEAN AS $$
DECLARE
    v_current_balance NUMERIC;
    v_rows_affected INT;
BEGIN
    -- 获取当前余额
    SELECT minutes_balance INTO v_current_balance
    FROM public.balances
    WHERE user_id = p_user_id
    FOR UPDATE; -- 加锁

    -- 检查余额是否足够
    IF v_current_balance IS NULL OR v_current_balance < p_minutes THEN
        RETURN FALSE;
    END IF;

    -- 扣减余额
    UPDATE public.balances
    SET
        minutes_balance = minutes_balance - p_minutes,
        updated_at = NOW()
    WHERE user_id = p_user_id
    AND minutes_balance >= p_minutes;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    RETURN v_rows_affected > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 2. 检查体验是否已使用
-- ============================================
CREATE OR REPLACE FUNCTION check_trial_used(
    p_user_id UUID DEFAULT NULL,
    p_anon_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    v_used BOOLEAN;
BEGIN
    -- 优先检查用户
    IF p_user_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.trial_usages
            WHERE user_id = p_user_id
        ) INTO v_used;

        IF v_used THEN
            RETURN TRUE;
        END IF;
    END IF;

    -- 检查匿名用户
    IF p_anon_id IS NOT NULL THEN
        SELECT used_trial INTO v_used
        FROM public.anon_tokens
        WHERE anon_id = p_anon_id;

        RETURN COALESCE(v_used, FALSE);
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 3. 记录体验使用
-- ============================================
CREATE OR REPLACE FUNCTION record_trial_usage(
    p_user_id UUID DEFAULT NULL,
    p_anon_id TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    -- 插入体验使用记录
    INSERT INTO public.trial_usages (anon_id, user_id, used_at)
    VALUES (p_anon_id, p_user_id, NOW());

    -- 更新 anon_tokens 的 used_trial 标记
    IF p_anon_id IS NOT NULL THEN
        UPDATE public.anon_tokens
        SET used_trial = TRUE
        WHERE anon_id = p_anon_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 4. 绑定匿名体验到用户
-- ============================================
CREATE OR REPLACE FUNCTION bind_trial_to_user(
    p_user_id UUID,
    p_anon_id TEXT
)
RETURNS VOID AS $$
BEGIN
    -- 更新 trial_usages 中的 user_id
    UPDATE public.trial_usages
    SET user_id = p_user_id
    WHERE anon_id = p_anon_id
    AND user_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. 获取用户余额和体验状态
-- ============================================
CREATE OR REPLACE FUNCTION get_balance_status(
    p_user_id UUID DEFAULT NULL,
    p_anon_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    minutes_balance NUMERIC,
    trial_available BOOLEAN,
    trial_remaining_minutes NUMERIC
) AS $$
DECLARE
    v_balance NUMERIC := 0;
    v_trial_used BOOLEAN;
BEGIN
    -- 获取余额
    IF p_user_id IS NOT NULL THEN
        SELECT COALESCE(b.minutes_balance, 0) INTO v_balance
        FROM public.balances b
        WHERE b.user_id = p_user_id;
    END IF;

    -- 检查体验状态
    v_trial_used := check_trial_used(p_user_id, p_anon_id);

    RETURN QUERY SELECT
        v_balance,
        NOT v_trial_used,
        CASE WHEN v_trial_used THEN 0::NUMERIC ELSE 30::NUMERIC END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
