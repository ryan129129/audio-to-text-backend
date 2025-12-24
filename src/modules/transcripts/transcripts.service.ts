import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { R2Service } from '../../providers/r2/r2.service';
import { Transcript, TranscriptSegment } from '../../database/entities';

export interface SaveTranscriptDto {
  task_id: string;
  segments: TranscriptSegment[];
  raw_response: Record<string, any>;
}

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);

  constructor(
    private supabaseService: SupabaseService,
    private r2Service: R2Service,
  ) {}

  /**
   * 保存转录结果
   * 统一在此处生成 SRT/VTT 文件，确保 segments 和字幕文件内容一致
   */
  async saveTranscript(dto: SaveTranscriptDto): Promise<Transcript> {
    const { task_id, segments, raw_response } = dto;
    const supabase = this.supabaseService.getClient();

    // 生成 SRT/VTT 内容
    const srtContent = this.generateSRT(segments);
    const vttContent = this.generateVTT(segments);

    // 上传到 R2
    let srtUrl: string | null = null;
    let vttUrl: string | null = null;
    let rawUrl: string | null = null;

    try {
      const srtKey = `transcripts/${task_id}/output.srt`;
      const vttKey = `transcripts/${task_id}/output.vtt`;
      const rawKey = `transcripts/${task_id}/raw.json`;

      [srtUrl, vttUrl, rawUrl] = await Promise.all([
        this.r2Service.uploadFile(srtKey, srtContent, 'text/plain; charset=utf-8'),
        this.r2Service.uploadFile(vttKey, vttContent, 'text/vtt; charset=utf-8'),
        this.r2Service.uploadFile(rawKey, JSON.stringify(raw_response), 'application/json; charset=utf-8'),
      ]);

      this.logger.log(`Uploaded transcript files for task ${task_id}`);
    } catch (r2Error) {
      this.logger.warn(`R2 upload failed for task ${task_id}: ${r2Error}`);
    }

    const transcript: Partial<Transcript> = {
      task_id,
      segments,
      raw_response,
      raw_url: rawUrl,
      srt_url: srtUrl,
      vtt_url: vttUrl,
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
   * 生成 SRT 格式字幕
   */
  private generateSRT(segments: TranscriptSegment[]): string {
    return segments
      .map((seg, i) => {
        const startTime = this.formatSRTTime(seg.start);
        const endTime = this.formatSRTTime(seg.end);
        return `${i + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
      })
      .join('\n');
  }

  /**
   * 生成 VTT 格式字幕
   */
  private generateVTT(segments: TranscriptSegment[]): string {
    const header = 'WEBVTT\n\n';
    const body = segments
      .map((seg) => {
        const startTime = this.formatVTTTime(seg.start);
        const endTime = this.formatVTTTime(seg.end);
        return `${startTime} --> ${endTime}\n${seg.text}\n`;
      })
      .join('\n');
    return header + body;
  }

  private formatSRTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  private formatVTTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
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
