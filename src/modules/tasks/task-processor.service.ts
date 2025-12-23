import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { DeepgramService } from '../../providers/deepgram/deepgram.service';
import { R2Service } from '../../providers/r2/r2.service';
import { YouTubeDownloaderService } from '../../providers/youtube/youtube-downloader.service';
import { YouTubeTranscriptService } from '../../providers/youtube/youtube-transcript.service';
import { TranscriptsService } from '../transcripts/transcripts.service';
import { AuthService } from '../auth/auth.service';
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
    private youtubeTranscript: YouTubeTranscriptService,
    private transcriptsService: TranscriptsService,
    private authService: AuthService,
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

      // YouTube 优先尝试获取字幕
      if (source_type === SourceType.YOUTUBE) {
        const transcriptResult = await this.tryGetYouTubeTranscript(task_id, source_url);
        if (transcriptResult) {
          // 字幕获取成功，直接返回
          await this.recordTrialUsageIfNeeded(task_id);
          this.logger.log(`Task ${task_id} completed successfully (YouTube transcript)`);
          return;
        }
        // 没有字幕，回退到下载音频 + Deepgram 转录
        this.logger.log(`No YouTube transcript available, falling back to audio download`);
      }

      // 常规流程：下载音频（如果需要）+ Deepgram 转录
      await this.processWithDeepgram(task_id, source_type, source_url, params);

      // 记录体验使用（如果是体验任务）
      await this.recordTrialUsageIfNeeded(task_id);

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
   * 尝试获取 YouTube 字幕
   * @returns 成功返回 true，失败返回 false
   */
  private async tryGetYouTubeTranscript(taskId: string, youtubeUrl: string): Promise<boolean> {
    try {
      this.logger.log(`Trying to get YouTube transcript for task ${taskId}`);
      const transcript = await this.youtubeTranscript.getTranscript(youtubeUrl);

      if (!transcript) {
        return false;
      }

      const { segments, duration } = transcript;

      // 生成 SRT/VTT 文件并上传到 R2
      const srtContent = this.generateSRT(segments);
      const vttContent = this.generateVTT(segments);

      let srtUrl = '';
      let vttUrl = '';
      let rawUrl = '';

      try {
        const srtKey = `transcripts/${taskId}/output.srt`;
        const vttKey = `transcripts/${taskId}/output.vtt`;
        const rawKey = `transcripts/${taskId}/raw.json`;

        [srtUrl, vttUrl, rawUrl] = await Promise.all([
          this.r2Service.uploadFile(srtKey, srtContent, 'text/plain'),
          this.r2Service.uploadFile(vttKey, vttContent, 'text/plain'),
          this.r2Service.uploadFile(rawKey, JSON.stringify(transcript), 'application/json'),
        ]);
      } catch (r2Error) {
        this.logger.warn(`R2 upload failed, skipping: ${r2Error}`);
      }

      // 保存转录结果
      await this.transcriptsService.saveTranscript({
        task_id: taskId,
        segments,
        raw_response: transcript,
        raw_url: rawUrl,
        srt_url: srtUrl,
        vtt_url: vttUrl,
      });

      // 更新任务状态（YouTube 字幕免费，cost_minutes 为 0）
      await this.updateTaskStatus(taskId, TaskStatus.SUCCEEDED, {
        duration_sec: duration,
        cost_minutes: 0,  // YouTube 字幕不消耗配额
      });

      this.logger.log(`YouTube transcript fetched successfully: ${segments.length} segments`);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to get YouTube transcript: ${error}`);
      return false;
    }
  }

  /**
   * 使用 Deepgram 进行转录
   */
  private async processWithDeepgram(
    taskId: string,
    sourceType: SourceType,
    sourceUrl: string,
    params?: Record<string, any> | null,
  ): Promise<void> {
    let audioUrl = sourceUrl;

    // YouTube 需要先下载音频
    if (sourceType === SourceType.YOUTUBE) {
      audioUrl = await this.downloadYouTubeAudio(taskId, sourceUrl);
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
      const srtKey = `transcripts/${taskId}/output.srt`;
      const vttKey = `transcripts/${taskId}/output.vtt`;
      const rawKey = `transcripts/${taskId}/raw.json`;

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
      task_id: taskId,
      segments,
      raw_response: result,
      raw_url: rawUrl,
      srt_url: srtUrl,
      vtt_url: vttUrl,
    });

    // 计算费用并更新任务
    const costMinutes = Math.ceil(duration / 60);
    await this.updateTaskStatus(taskId, TaskStatus.SUCCEEDED, {
      duration_sec: duration,
      cost_minutes: costMinutes,
    });
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
   * 如果是体验任务，记录体验使用
   */
  private async recordTrialUsageIfNeeded(taskId: string): Promise<void> {
    const supabase = this.supabaseService.getClient();

    // 查询任务获取 user_id, anon_id, is_trial
    const { data: task, error } = await supabase
      .from('tasks')
      .select('user_id, anon_id, is_trial')
      .eq('id', taskId)
      .single();

    if (error || !task) {
      this.logger.warn(`Failed to get task info for trial recording: ${error?.message}`);
      return;
    }

    // 如果是体验任务，记录使用
    if (task.is_trial) {
      this.logger.log(`Recording trial usage for task ${taskId}`);
      await this.authService.recordTrialUsage(task.user_id, task.anon_id);
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
