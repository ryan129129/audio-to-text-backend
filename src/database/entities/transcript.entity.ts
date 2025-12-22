/**
 * 转录片段
 */
export interface TranscriptSegment {
  start: number; // 开始时间（秒）
  end: number; // 结束时间（秒）
  text: string;
  speaker: string | null; // 说话人标识
}

/**
 * 转录结果实体（对应 transcripts 表）
 */
export interface Transcript {
  task_id: string; // PK, FK -> tasks
  segments: TranscriptSegment[];
  raw_response: Record<string, any>; // 原始引擎输出
  raw_url: string | null; // R2 中的原始响应 URL
  srt_url: string | null; // R2 中的 SRT 文件 URL
  vtt_url: string | null; // R2 中的 VTT 文件 URL
  created_at: string;
}
