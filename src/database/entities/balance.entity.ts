/**
 * 余额实体（对应 balances 表）
 */
export interface Balance {
  user_id: string; // PK
  minutes_balance: number; // 分钟余额
  updated_at: string;
}
