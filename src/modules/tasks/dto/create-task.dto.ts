import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsObject,
} from 'class-validator';
import { SourceType, TaskType } from '../../../database/entities';

export class CreateTaskDto {
  @IsEnum(TaskType)
  @IsOptional()
  task_type?: TaskType = TaskType.TRANSCRIPTION;

  @IsEnum(SourceType)
  @IsNotEmpty()
  source_type: SourceType;

  @IsString()
  @IsNotEmpty()
  source_url: string;

  @IsNumber()
  @IsOptional()
  size_bytes?: number;

  @IsBoolean()
  @IsOptional()
  is_trial?: boolean;

  @IsObject()
  @IsOptional()
  params?: Record<string, any>;
}

export class CreateTaskResponseDto {
  task_id: string;
  status: string;
  retry_after: number;
}
