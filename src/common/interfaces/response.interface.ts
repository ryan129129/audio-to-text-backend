/**
 * 统一响应格式
 * { data: T | null, error: { code, message, details? } | null }
 */
export interface ApiResponse<T = any> {
  data: T | null;
  error: ApiError | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

/**
 * 错误码枚举
 */
export enum ErrorCode {
  INVALID_INPUT = 'INVALID_INPUT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  TRIAL_EXHAUSTED = 'TRIAL_EXHAUSTED',
  CONFLICT = 'CONFLICT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  ENGINE_ERROR = 'ENGINE_ERROR',
  DURATION_EXCEEDED = 'DURATION_EXCEEDED',
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * 当前用户上下文
 */
export interface CurrentUser {
  id: string | null; // user_id from Supabase JWT, null for anonymous
  anonId: string | null; // anon_id from X-Anon-Id header
  isAuthenticated: boolean;
}
