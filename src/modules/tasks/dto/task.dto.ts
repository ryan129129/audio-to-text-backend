import { IsOptional, IsString, IsEnum, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskStatus } from '../../../database/entities';

export class GetTasksQueryDto {
  @IsEnum(TaskStatus)
  @IsOptional()
  status?: TaskStatus;

  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @IsOptional()
  limit?: number = 20;

  @IsString()
  @IsOptional()
  cursor?: string;
}

export interface TaskResponseDto {
  task_id: string;
  status: string;
  source_type: string;
  priority: string;
  engine: string;
  duration_sec: number | null;
  cost_minutes: number | null;
  result?: {
    segments: Array<{
      start: number;
      end: number;
      text: string;
      speaker: string | null;
    }>;
    raw_url: string | null;
    srt_url: string | null;
    vtt_url: string | null;
  };
  error: { code: string; message: string } | null;
  retry_after?: number;
  created_at: string;
}

export interface TaskListResponseDto {
  items: TaskResponseDto[];
  next_cursor: string | null;
}
