import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { Transcript, TranscriptSegment } from '../../database/entities';

export interface SaveTranscriptDto {
  task_id: string;
  segments: TranscriptSegment[];
  raw_response: Record<string, any>;
  raw_url: string | null;
  srt_url: string | null;
  vtt_url: string | null;
}

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);

  constructor(private supabaseService: SupabaseService) {}

  /**
   * 保存转录结果
   */
  async saveTranscript(dto: SaveTranscriptDto): Promise<Transcript> {
    const supabase = this.supabaseService.getClient();

    const transcript: Partial<Transcript> = {
      task_id: dto.task_id,
      segments: dto.segments,
      raw_response: dto.raw_response,
      raw_url: dto.raw_url,
      srt_url: dto.srt_url,
      vtt_url: dto.vtt_url,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('transcripts')
      .upsert(transcript, { onConflict: 'task_id' })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to save transcript: ${error.message}`);
      throw error;
    }

    return data as Transcript;
  }

  /**
   * 获取转录结果
   */
  async getTranscript(taskId: string): Promise<Transcript | null> {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('transcripts')
      .select('*')
      .eq('task_id', taskId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as Transcript;
  }
}
