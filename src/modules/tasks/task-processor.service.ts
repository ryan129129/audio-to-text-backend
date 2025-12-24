import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { DeepgramService } from '../../providers/deepgram/deepgram.service';
import { SupadataService, TranscriptResult } from '../../providers/supadata/supadata.service';
import { OpenAIService } from '../../providers/openai/openai.service';
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
    private supadataService: SupadataService,
    private openAIService: OpenAIService,
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

      let result: TranscriptResult;
      let costMinutes = 0;

      if (source_type === SourceType.YOUTUBE) {
        // YouTube 使用 Supadata 处理（支持自动获取字幕或 AI 生成）
        result = await this.processWithSupadata(source_url, params?.language);
        // Supadata 计费：现成字幕免费(isGenerated=false)，AI 生成按分钟计费
        if (result.isGenerated) {
          costMinutes = Math.ceil(result.duration / 60);
        }
      } else {
        // 上传的音频文件使用 Deepgram
        result = await this.processWithDeepgram(source_url, params);
        costMinutes = Math.ceil(result.duration / 60);
      }

      // 保存转录结果
      await this.transcriptsService.saveTranscript({
        task_id,
        segments: result.segments,
        raw_response: result,
      });

      // 更新任务状态
      await this.updateTaskStatus(task_id, TaskStatus.SUCCEEDED, {
        duration_sec: result.duration,
        cost_minutes: costMinutes,
      });

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
   * 使用 Supadata 处理 YouTube 视频转录
   * 自动获取现成字幕，无字幕时使用 AI 生成
   */
  private async processWithSupadata(videoUrl: string, language?: string): Promise<TranscriptResult> {
    this.logger.log(`Processing YouTube video with Supadata: ${videoUrl}`);
    const result = await this.supadataService.getTranscript(videoUrl, language, 'auto');
    this.logger.log(`Supadata result: ${result.segments.length} segments, duration: ${result.duration}s, generated: ${result.isGenerated}`);
    return result;
  }

  /**
   * 使用 Deepgram 进行转录（用于上传的音频文件）
   * 注意：params.language 是目标翻译语言，不是音频源语言
   */
  private async processWithDeepgram(
    audioUrl: string,
    params?: Record<string, any> | null,
  ): Promise<TranscriptResult> {
    this.logger.log(`Processing audio with Deepgram: ${audioUrl}`);

    // 调用 Deepgram 进行转录（让 Deepgram 自动检测音频语言）
    const result = await this.deepgramService.transcribeUrlSync(audioUrl, {
      diarize: true,
      detect_language: true,  // 始终自动检测音频语言
    });

    // 提取片段（Deepgram utterances 已经是完整句子，无需合并）
    let segments = this.extractSegments(result);
    const duration = result.duration;

    // 如果指定了目标语言，进行翻译
    const targetLanguage = params?.language;
    if (targetLanguage && this.openAIService.isAvailable()) {
      this.logger.log(`Translating ${segments.length} segments to ${targetLanguage}...`);
      segments = await this.openAIService.translateSegments(segments, targetLanguage);
      this.logger.log(`Translation completed`);
    }

    return {
      segments,
      duration,
      language: params?.language || 'unknown',
      isGenerated: true,  // Deepgram 总是 AI 生成
    };
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
   * 从 Deepgram 结果提取片段
   * 优先使用 utterances（按语义分段），fallback 到 words
   */
  private extractSegments(result: any): Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }> {
    // 优先使用 utterances（Deepgram 按语义分段的结果）
    if (result.utterances && result.utterances.length > 0) {
      this.logger.log(`Using ${result.utterances.length} utterances from Deepgram`);
      return result.utterances.map((utterance: any) => ({
        start: utterance.start,
        end: utterance.end,
        text: utterance.transcript,
        speaker: utterance.speaker !== undefined ? `Speaker ${utterance.speaker}` : null,
      }));
    }

    // Fallback: 从 words 构建 segments（按 speaker + 时间间隔分段）
    this.logger.log('No utterances, building segments from words');
    const segments: Array<{
      start: number;
      end: number;
      text: string;
      speaker: string | null;
    }> = [];

    const channel = result.channels?.[0];
    if (!channel) return segments;

    const words = channel.alternatives?.[0]?.words || [];
    if (words.length === 0) return segments;

    // 按 speaker 变化或时间间隔（超过 1 秒）分段
    const TIME_GAP_THRESHOLD = 1.0; // 秒
    let currentSegment: { start: number; end: number; text: string; speaker: number | null } | null = null;

    for (const word of words) {
      const speaker = word.speaker ?? null;
      const wordText = word.punctuated_word || word.word;

      // 判断是否需要开始新 segment
      const shouldStartNew = !currentSegment ||
        currentSegment.speaker !== speaker ||
        (word.start - currentSegment.end) > TIME_GAP_THRESHOLD;

      if (shouldStartNew) {
        if (currentSegment) {
          segments.push({
            ...currentSegment,
            speaker: currentSegment.speaker !== null ? `Speaker ${currentSegment.speaker}` : null,
          });
        }
        currentSegment = {
          start: word.start,
          end: word.end,
          text: wordText,
          speaker,
        };
      } else {
        currentSegment!.end = word.end;
        currentSegment!.text += ' ' + wordText;
      }
    }

    if (currentSegment) {
      segments.push({
        ...currentSegment,
        speaker: currentSegment.speaker !== null ? `Speaker ${currentSegment.speaker}` : null,
      });
    }

    this.logger.log(`Built ${segments.length} segments from ${words.length} words`);
    return segments;
  }
}
