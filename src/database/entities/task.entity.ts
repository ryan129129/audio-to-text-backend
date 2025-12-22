/**
 * 任务状态枚举
 */
export enum TaskStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/**
 * 任务来源类型
 */
export enum SourceType {
  UPLOAD = 'upload',
  URL = 'url',
  YOUTUBE = 'youtube',
}

/**
 * 任务类型
 */
export enum TaskType {
  TRANSCRIPTION = 'transcription',
}

/**
 * 优先级
 */
export enum Priority {
  PAID = 'paid',
  FREE = 'free',
}

/**
 * 引擎类型
 */
export enum Engine {
  DEEPGRAM = 'deepgram',
}

/**
 * 任务实体（对应 tasks 表）
 */
export interface Task {
  id: string; // uuid
  user_id: string | null; // 匿名时为 null
  anon_id: string | null;
  task_type: TaskType;
  source_type: SourceType;
  source_url: string;
  size_bytes: number | null; // 可选，仅作记录
  is_trial: boolean;
  priority: Priority;
  status: TaskStatus;
  engine: Engine;
  engine_config: Record<string, any> | null;
  params: Record<string, any> | null;
  duration_sec: number | null; // 完成后回填
  cost_minutes: number | null; // 完成后回填
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 创建任务 DTO
 */
export interface CreateTaskDto {
  task_type?: TaskType;
  source_type: SourceType;
  source_url: string;
  size_bytes?: number;
  is_trial?: boolean;
  params?: Record<string, any>;
}
