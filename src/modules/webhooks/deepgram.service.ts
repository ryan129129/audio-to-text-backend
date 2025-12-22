import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { R2Service } from '../../providers/r2/r2.service';
import { DeepgramService } from '../../providers/deepgram/deepgram.service';
import { TasksService } from '../tasks/tasks.service';
import { TranscriptsService } from '../transcripts/transcripts.service';
import { BillingService } from '../billing/billing.service';
import { AuthService } from '../auth/auth.service';
import { TaskStatus } from '../../database/entities';

@Injectable()
export class DeepgramWebhookService {
  private readonly logger = new Logger(DeepgramWebhookService.name);

  constructor(
    private supabaseService: SupabaseService,
    private r2Service: R2Service,
    private deepgramService: DeepgramService,
    private tasksService: TasksService,
    private transcriptsService: TranscriptsService,
    private billingService: BillingService,
    private authService: AuthService,
  ) {}

  /**
   * 处理 Deepgram Webhook
   */
  async handleWebhook(body: any, signature: string, rawBody?: string): Promise<void> {
    // 验证签名
    const webhookSecret = this.deepgramService.getWebhookSecret();
    if (webhookSecret && rawBody) {
      const isValid = this.deepgramService.verifyWebhookSignature(
        rawBody,
        signature,
        webhookSecret,
      );
      if (!isValid) {
        this.logger.error('Invalid Deepgram webhook signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
    }

    this.logger.log('Received Deepgram webhook');

    const taskId = body.metadata?.task_id || body.request_id;
    if (!taskId) {
      this.logger.warn('No task_id in webhook payload');
      return;
    }

    // 获取任务信息
    const supabase = this.supabaseService.getClient();
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (!task) {
      this.logger.warn(`Task not found: ${taskId}`);
      return;
    }

    // 幂等检查
    if (task.status === TaskStatus.SUCCEEDED || task.status === TaskStatus.FAILED) {
      this.logger.log(`Task ${taskId} already completed, skipping`);
      return;
    }

    try {
      const result = body.results;
      const duration = result?.duration || 0;

      // 提取片段
      const segments = this.extractSegments(result);

      // 上传结果到 R2
      const srtContent = this.generateSRT(segments);
      const vttContent = this.generateVTT(segments);

      const srtKey = `transcripts/${taskId}/output.srt`;
      const vttKey = `transcripts/${taskId}/output.vtt`;
      const rawKey = `transcripts/${taskId}/raw.json`;

      const [srtUrl, vttUrl, rawUrl] = await Promise.all([
        this.r2Service.uploadFile(srtKey, srtContent, 'text/plain'),
        this.r2Service.uploadFile(vttKey, vttContent, 'text/plain'),
        this.r2Service.uploadFile(rawKey, JSON.stringify(body), 'application/json'),
      ]);

      // 保存转录结果
      await this.transcriptsService.saveTranscript({
        task_id: taskId,
        segments,
        raw_response: body,
        raw_url: rawUrl,
        srt_url: srtUrl,
        vtt_url: vttUrl,
      });

      // 计算费用
      const costMinutes = Math.ceil(duration / 60);

      // 扣费（唯一扣费点）
      if (!task.is_trial && task.user_id) {
        const success = await this.billingService.deductBalance(task.user_id, costMinutes);
        if (!success) {
          this.logger.error(`Failed to deduct balance for task ${taskId}`);
        }
      }

      // 如果是体验任务，标记体验已用
      if (task.is_trial) {
        await this.authService.recordTrialUsage(task.user_id, task.anon_id);
      }

      // 更新任务状态
      await this.tasksService.updateTaskStatus(taskId, TaskStatus.SUCCEEDED, {
        duration_sec: duration,
        cost_minutes: costMinutes,
      });

      this.logger.log(`Task ${taskId} completed via webhook`);
    } catch (error) {
      this.logger.error(`Failed to process webhook for task ${taskId}: ${error}`);
      await this.tasksService.updateTaskStatus(taskId, TaskStatus.FAILED, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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

    const channel = result?.channels?.[0];
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

  private generateSRT(segments: Array<{ start: number; end: number; text: string }>): string {
    return segments
      .map((seg, i) => {
        const startTime = this.formatSRTTime(seg.start);
        const endTime = this.formatSRTTime(seg.end);
        return `${i + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
      })
      .join('\n');
  }

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
