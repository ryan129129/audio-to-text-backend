import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Supadata API 响应中的字幕片段
interface SupadataChunk {
  text: string;
  offset: number;    // 毫秒
  duration: number;  // 毫秒
  lang?: string;
}

// Supadata API 响应
interface SupadataResponse {
  content: SupadataChunk[] | string;
  lang: string;
  availableLangs?: string[];
}

// 异步任务响应
interface SupadataJobResponse {
  jobId: string;
}

// 统一的转录结果格式
export interface TranscriptResult {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }>;
  duration: number;
  language: string;
  isGenerated: boolean;  // 是否 AI 生成（用于计费）
}

@Injectable()
export class SupadataService {
  private readonly logger = new Logger(SupadataService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.supadata.ai/v1';

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('SUPADATA_API_KEY') || '';
    if (!this.apiKey) {
      this.logger.warn('SUPADATA_API_KEY not configured');
    }
  }

  /**
   * 获取视频转录
   * @param videoUrl 视频 URL（支持 YouTube、TikTok、Instagram 等）
   * @param language 语言代码（如 'zh', 'en', 'ja'）
   * @param mode 模式：'auto' 自动选择, 'native' 仅现成字幕, 'generate' 强制 AI 生成
   */
  async getTranscript(
    videoUrl: string,
    language?: string,
    mode: 'auto' | 'native' | 'generate' = 'auto',
  ): Promise<TranscriptResult> {
    this.logger.log(`Fetching transcript for ${videoUrl}, lang: ${language || 'auto'}, mode: ${mode}`);

    const params = new URLSearchParams({
      url: videoUrl,
      mode,
    });

    if (language) {
      params.append('lang', language);
    }

    const response = await fetch(`${this.baseUrl}/transcript?${params}`, {
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    // 异步任务，需要轮询
    if (response.status === 202) {
      const jobResponse: SupadataJobResponse = await response.json();
      this.logger.log(`Async job started: ${jobResponse.jobId}`);
      return this.pollJob(jobResponse.jobId, mode !== 'native');
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Supadata API error: ${response.status} - ${errorText}`);
      throw new Error(`Supadata API error: ${response.status} - ${errorText}`);
    }

    const data: SupadataResponse = await response.json();
    return this.parseResponse(data, mode !== 'native');
  }

  /**
   * 仅获取现成字幕（不使用 AI 生成）
   * 成本：1 credit
   */
  async getNativeTranscript(videoUrl: string, language?: string): Promise<TranscriptResult | null> {
    try {
      return await this.getTranscript(videoUrl, language, 'native');
    } catch (error: any) {
      // native 模式下没有字幕会返回错误
      if (error.message?.includes('404') || error.message?.includes('not found')) {
        this.logger.log('No native transcript available');
        return null;
      }
      throw error;
    }
  }

  /**
   * 强制 AI 生成转录
   * 成本：2 credits/分钟
   */
  async generateTranscript(videoUrl: string, language?: string): Promise<TranscriptResult> {
    return this.getTranscript(videoUrl, language, 'generate');
  }

  /**
   * 轮询异步任务
   * @param jobId 任务 ID
   * @param isGenerated 是否为 AI 生成
   * @param maxAttempts 最大尝试次数（默认 120 次，即 10 分钟）
   * @param intervalMs 轮询间隔（默认 5 秒）
   */
  private async pollJob(
    jobId: string,
    isGenerated: boolean,
    maxAttempts = 120,
    intervalMs = 5000,
  ): Promise<TranscriptResult> {
    this.logger.log(`Polling job ${jobId}, max attempts: ${maxAttempts}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.sleep(intervalMs);

      const response = await fetch(`${this.baseUrl}/transcript/${jobId}`, {
        headers: {
          'x-api-key': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Job ${jobId} failed: ${response.status} - ${errorText}`);
        throw new Error(`Supadata job failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // 检查是否仍在处理中（status: "active"）
      if (data.status === 'active') {
        if (attempt % 12 === 0) {
          this.logger.log(`Job ${jobId} still processing... (attempt ${attempt}/${maxAttempts})`);
        }
        continue;
      }

      // 有 content 表示处理完成
      if (data.content !== undefined) {
        this.logger.log(`Job ${jobId} completed after ${attempt} attempts`);
        return this.parseResponse(data as SupadataResponse, isGenerated);
      }

      // 其他未知状态
      this.logger.warn(`Job ${jobId} unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    throw new Error(`Supadata job ${jobId} timeout after ${maxAttempts} attempts`);
  }

  /**
   * 解析 Supadata 响应为统一格式
   */
  private parseResponse(data: SupadataResponse, isGenerated: boolean): TranscriptResult {
    // 如果返回的是纯文本（text=true 参数）
    if (typeof data.content === 'string') {
      return {
        segments: [{
          start: 0,
          end: 0,
          text: data.content,
          speaker: null,
        }],
        duration: 0,
        language: data.lang || 'unknown',
        isGenerated,
      };
    }

    // 带时间戳的字幕
    const segments = data.content.map((chunk) => ({
      start: chunk.offset / 1000,  // ms -> s
      end: (chunk.offset + chunk.duration) / 1000,
      text: chunk.text.trim(),
      speaker: null,  // Supadata 不提供说话人信息
    }));

    // 计算总时长
    const lastSegment = segments[segments.length - 1];
    const duration = lastSegment ? lastSegment.end : 0;

    this.logger.log(`Parsed ${segments.length} segments, duration: ${duration.toFixed(1)}s, generated: ${isGenerated}`);

    return {
      segments,
      duration,
      language: data.lang || 'unknown',
      isGenerated,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
