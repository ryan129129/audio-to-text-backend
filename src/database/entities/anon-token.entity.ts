/**
 * 匿名 Token 实体（对应 anon_tokens 表）
 */
export interface AnonToken {
  id: string; // uuid
  anon_id: string; // 前端生成的随机 token
  ip_hash: string; // IP 哈希，用于辅助风控
  ua_hash: string; // User-Agent 哈希，用于辅助风控
  created_at: string;
  used_trial: boolean; // 是否已创建过体验任务
}

/**
 * 体验使用记录实体（对应 trial_usages 表）
 */
export interface TrialUsage {
  id: string;
  anon_id: string;
  user_id: string | null;
  used_at: string;
}
