import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIService } from '../openai/openai.service';

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

  constructor(
    private configService: ConfigService,
    private openAIService: OpenAIService,
  ) {
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
    return this.parseResponse(data, mode !== 'native', language);
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
        return this.parseResponse(data as SupadataResponse, isGenerated, undefined);
      }

      // 其他未知状态
      this.logger.warn(`Job ${jobId} unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    throw new Error(`Supadata job ${jobId} timeout after ${maxAttempts} attempts`);
  }

  /**
   * 解析 Supadata 响应为统一格式
   * @param data Supadata API 响应
   * @param isGenerated 是否为 AI 生成（用于决定是否使用 LLM 合并）
   * @param language 语言代码（用于 LLM 合并）
   */
  private async parseResponse(
    data: SupadataResponse,
    isGenerated: boolean,
    language?: string,
  ): Promise<TranscriptResult> {
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
    const rawSegments = data.content.map((chunk) => ({
      start: chunk.offset / 1000,  // ms -> s
      end: (chunk.offset + chunk.duration) / 1000,
      text: chunk.text.trim(),
      speaker: null as string | null,  // Supadata 不提供说话人信息
    }));

    let segments: typeof rawSegments;

    // AI 生成的结果使用 LLM 合并（如果可用）
    if (isGenerated && this.openAIService.isAvailable()) {
      this.logger.log('Using LLM to merge segments...');
      segments = await this.openAIService.mergeTranscriptSegments(rawSegments, {
        language: language || data.lang,
      });
    } else {
      // 现成字幕或 LLM 不可用时，使用规则合并
      segments = this.mergeSegments(rawSegments);
    }

    // 计算总时长
    const lastSegment = segments[segments.length - 1];
    const duration = lastSegment ? lastSegment.end : 0;

    this.logger.log(
      `Parsed ${rawSegments.length} raw segments -> merged to ${segments.length} segments, ` +
      `duration: ${duration.toFixed(1)}s, generated: ${isGenerated}, llm: ${isGenerated && this.openAIService.isAvailable()}`
    );

    return {
      segments,
      duration,
      language: data.lang || 'unknown',
      isGenerated,
    };
  }

  /**
   * 合并短片段为完整句子
   * 规则：
   * 1. 时间间隔小于阈值时合并
   * 2. 遇到句末标点（。！？.!?）时断句
   * 3. 不同 speaker 不合并
   * 4. 单个 segment 不超过最大长度
   */
  private mergeSegments(
    segments: Array<{ start: number; end: number; text: string; speaker: string | null }>,
    options: {
      maxGapSeconds?: number;    // 最大时间间隔，超过则断句（默认 1.5 秒）
      maxLengthChars?: number;   // 单个 segment 最大字符数（默认 200）
    } = {},
  ): Array<{ start: number; end: number; text: string; speaker: string | null }> {
    const { maxGapSeconds = 1.5, maxLengthChars = 200 } = options;

    if (segments.length === 0) return [];

    // 句末标点符号（中英文）
    const sentenceEndPattern = /[。！？.!?]$/;

    const merged: Array<{ start: number; end: number; text: string; speaker: string | null }> = [];
    let current: { start: number; end: number; text: string; speaker: string | null } | null = null;

    for (const seg of segments) {
      if (!current) {
        // 初始化第一个 segment
        current = { ...seg };
        continue;
      }

      // 判断是否需要断句
      const gap = seg.start - current.end;
      const differentSpeaker = current.speaker !== seg.speaker;
      const endsWithPunctuation = sentenceEndPattern.test(current.text);
      const wouldExceedMaxLength = (current.text + seg.text).length > maxLengthChars;
      const gapTooLarge = gap > maxGapSeconds;

      if (differentSpeaker || endsWithPunctuation || wouldExceedMaxLength || gapTooLarge) {
        // 保存当前 segment，开始新的
        merged.push(current);
        current = { ...seg };
      } else {
        // 合并到当前 segment
        current.end = seg.end;
        current.text = this.smartJoinText(current.text, seg.text);
      }
    }

    // 保存最后一个 segment
    if (current) {
      // 最终清理：去除中文字符之间的多余空格
      current.text = this.cleanChineseSpaces(current.text);
      merged.push(current);
    }

    return merged;
  }

  /**
   * 智能拼接文本
   * - 英文单词之间：保留/添加空格
   * - 中文字符之间：不加空格
   * - 中英文混合：根据边界字符决定
   */
  private smartJoinText(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;

    const lastChar = left[left.length - 1];
    const firstChar = right[0];

    // 英文/数字之间需要空格
    const isLastAlphanumeric = /[a-zA-Z0-9]/.test(lastChar);
    const isFirstAlphanumeric = /[a-zA-Z0-9]/.test(firstChar);
    if (isLastAlphanumeric && isFirstAlphanumeric) {
      return left + ' ' + right;
    }

    // 其他情况直接拼接（中文之间、中英混合边界）
    return left + right;
  }

  /**
   * 清理中文字符之间的多余空格
   * 保留英文单词之间的空格
   */
  private cleanChineseSpaces(text: string): string {
    // 匹配：中文 + 空格 + 中文，去掉中间的空格
    // 使用循环处理连续的情况
    let result = text;
    let prev = '';
    while (result !== prev) {
      prev = result;
      result = result.replace(/([\u4e00-\u9fa5，。！？、：；""''（）【】])\s+([\u4e00-\u9fa5，。！？、：；""''（）【】])/g, '$1$2');
    }
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
