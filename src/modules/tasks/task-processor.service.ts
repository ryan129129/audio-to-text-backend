import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { DeepgramService } from '../../providers/deepgram/deepgram.service';
import { R2Service } from '../../providers/r2/r2.service';
import { YouTubeDownloaderService } from '../../providers/youtube/youtube-downloader.service';
import { TranscriptsService } from '../transcripts/transcripts.service';
import { TaskStatus, SourceType } from '../../database/entities';

export interface TaskJobData {
  task_id: string;
  task_type: string;
  source_type: SourceType;
  source_url: string;
  engine: string;
  params?: Record<string, any> | null;
}

@Injectable()
export class TaskProcessorService {
  private readonly logger = new Logger(TaskProcessorService.name);

  constructor(
    private supabaseService: SupabaseService,
    private deepgramService: DeepgramService,
    private r2Service: R2Service,
    private youtubeDownloader: YouTubeDownloaderService,
    private transcriptsService: TranscriptsService,
  ) {}

  /**
   * 处理转录任务（核心逻辑）
   */
  async processTask(data: TaskJobData): Promise<void> {
    const { task_id, source_type, source_url, params } = data;
    this.logger.log(`Processing task ${task_id}`);

    try {
      // 更新状态为 processing
      await this.updateTaskStatus(task_id, TaskStatus.PROCESSING);

      let audioUrl = source_url;

      // YouTube 需要先下载音频
      if (source_type === SourceType.YOUTUBE) {
        audioUrl = await this.downloadYouTubeAudio(task_id, source_url);
      }

      // 调用 Deepgram 进行转录（同步模式）
      const result = await this.deepgramService.transcribeUrlSync(audioUrl, {
        diarize: true,
        detect_language: params?.detect_language ?? true,
        language: params?.language,
      });

      // 处理转录结果
      const duration = result.duration;
      const segments = this.extractSegments(result);

      // 生成 SRT/VTT 文件并上传到 R2
      const srtContent = this.generateSRT(segments);
      const vttContent = this.generateVTT(segments);

      let srtUrl = '';
      let vttUrl = '';
      let rawUrl = '';

      try {
        const srtKey = `transcripts/${task_id}/output.srt`;
        const vttKey = `transcripts/${task_id}/output.vtt`;
        const rawKey = `transcripts/${task_id}/raw.json`;

        [srtUrl, vttUrl, rawUrl] = await Promise.all([
          this.r2Service.uploadFile(srtKey, srtContent, 'text/plain'),
          this.r2Service.uploadFile(vttKey, vttContent, 'text/plain'),
          this.r2Service.uploadFile(rawKey, JSON.stringify(result), 'application/json'),
        ]);
      } catch (r2Error) {
        this.logger.warn(`R2 upload failed, skipping: ${r2Error}`);
      }

      // 保存转录结果
      await this.transcriptsService.saveTranscript({
        task_id,
        segments,
        raw_response: result,
        raw_url: rawUrl,
        srt_url: srtUrl,
        vtt_url: vttUrl,
      });

      // 计算费用并更新任务
      const costMinutes = Math.ceil(duration / 60);
      await this.updateTaskStatus(task_id, TaskStatus.SUCCEEDED, {
        duration_sec: duration,
        cost_minutes: costMinutes,
      });

      this.logger.log(`Task ${task_id} completed successfully`);
    } catch (error) {
      this.logger.error(`Task ${task_id} failed: ${error}`);
      await this.updateTaskStatus(task_id, TaskStatus.FAILED, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    updates: Record<string, any> = {},
  ): Promise<void> {
    const supabase = this.supabaseService.getClient();

    const { error } = await supabase
      .from('tasks')
      .update({
        status,
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    if (error) {
      this.logger.error(`Failed to update task status: ${error.message}`);
    }
  }

  /**
   * 下载 YouTube 音频并上传到 R2
   */
  private async downloadYouTubeAudio(taskId: string, youtubeUrl: string): Promise<string> {
    this.logger.log(`Downloading YouTube audio for task ${taskId}`);
    const result = await this.youtubeDownloader.downloadAndUpload(youtubeUrl, taskId);
    this.logger.log(`YouTube audio downloaded: ${result.audioUrl}, duration: ${result.duration}s`);
    return result.audioUrl;
  }

  /**
   * 从 Deepgram 结果提取片段
   */
  private extractSegments(result: any): Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }> {
    const segments: Array<{
      start: number;
      end: number;
      text: string;
      speaker: string | null;
    }> = [];

    const channel = result.channels?.[0];
    if (!channel) return segments;

    const words = channel.alternatives?.[0]?.words || [];
    let currentSegment: { start: number; end: number; text: string; speaker: number | null } | null = null;

    for (const word of words) {
      const speaker = word.speaker ?? null;

      if (!currentSegment || currentSegment.speaker !== speaker) {
        if (currentSegment) {
          segments.push({
            ...currentSegment,
            speaker: currentSegment.speaker !== null ? `Speaker ${currentSegment.speaker}` : null,
          });
        }
        currentSegment = {
          start: word.start,
          end: word.end,
          text: word.word,
          speaker,
        };
      } else {
        currentSegment.end = word.end;
        currentSegment.text += ' ' + word.word;
      }
    }

    if (currentSegment) {
      segments.push({
        ...currentSegment,
        speaker: currentSegment.speaker !== null ? `Speaker ${currentSegment.speaker}` : null,
      });
    }

    return segments;
  }

  /**
   * 生成 SRT 格式字幕
   */
  private generateSRT(segments: Array<{ start: number; end: number; text: string }>): string {
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
  private generateVTT(segments: Array<{ start: number; end: number; text: string }>): string {
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
}
