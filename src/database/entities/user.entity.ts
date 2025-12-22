/**
 * 用户实体（对应 Supabase users 表）
 */
export interface User {
  id: string; // uuid
  email: string;
  provider: 'email' | 'google';
  created_at: string;
}
