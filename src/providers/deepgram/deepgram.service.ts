import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Deepgram 转录参数
 * @see https://developers.deepgram.com/docs/features
 */
export interface DeepgramTranscriptionOptions {
  /** 模型名称，默认 nova-3 */
  model?: string;
  /** 指定音频语言（BCP-47 格式），如 en, zh, ja */
  language?: string;
  /** 识别说话人变化，为每个词分配 speaker ID，默认 true */
  diarize?: boolean;
  /** 自动检测音频语言，返回 detected_language 和 language_confidence，默认 true */
  detect_language?: boolean;
  /** 将语音分割成语义单元，返回 utterances 数组（含时间戳、说话人），默认 true */
  utterances?: boolean;
  /** 异步模式的回调 URL */
  callback_url?: string;
}

// Deepgram utterance（按语义分段的结果）
export interface DeepgramUtterance {
  start: number;
  end: number;
  confidence: number;
  channel: number;
  transcript: string;
  speaker?: number;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: number;
    punctuated_word?: string;
  }>;
}

export interface DeepgramResult {
  duration: number;
  channels: Array<{
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
        speaker?: number;
        punctuated_word?: string;
      }>;
    }>;
  }>;
  // utterances 是按语义分段的结果，比 words 更适合做字幕
  utterances?: DeepgramUtterance[];
}

@Injectable()
export class DeepgramService implements OnModuleInit {
  private readonly logger = new Logger(DeepgramService.name);
  private apiKey: string;
  private readonly baseUrl = 'https://api.deepgram.com/v1';

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.apiKey = this.configService.get<string>('deepgram.apiKey') || '';
    if (!this.apiKey) {
      this.logger.warn('Deepgram API key not configured');
    } else {
      this.logger.log('Deepgram service initialized');
    }
  }

  /**
   * 提交音频 URL 进行转录（异步回调模式）
   */
  async transcribeUrl(
    audioUrl: string,
    options: DeepgramTranscriptionOptions = {},
  ): Promise<{ request_id: string }> {
    const params = new URLSearchParams({
      model: options.model || 'nova-3',
      diarize: String(options.diarize ?? true),            // 识别说话人
      detect_language: String(options.detect_language ?? true),  // 自动检测语言
      punctuate: 'true',                                   // 添加标点
      utterances: String(options.utterances ?? true),      // 返回语义分段
    });

    if (options.language) {
      params.set('language', options.language);
    }

    if (options.callback_url) {
      params.set('callback', options.callback_url);
    }

    const response = await fetch(`${this.baseUrl}/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: audioUrl }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deepgram API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    return { request_id: result.request_id || result.metadata?.request_id };
  }

  /**
   * 同步转录（等待结果）
   */
  async transcribeUrlSync(
    audioUrl: string,
    options: Omit<DeepgramTranscriptionOptions, 'callback_url'> = {},
  ): Promise<DeepgramResult> {
    const params = new URLSearchParams({
      model: options.model || 'nova-3',
      diarize: String(options.diarize ?? true),            // 识别说话人
      detect_language: String(options.detect_language ?? true),  // 自动检测语言
      punctuate: 'true',                                   // 添加标点
      utterances: String(options.utterances ?? true),      // 返回语义分段
    });

    if (options.language) {
      params.set('language', options.language);
    }

    const response = await fetch(`${this.baseUrl}/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: audioUrl }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deepgram API error: ${response.status} - ${error}`);
    }

    const result = await response.json();

    this.logger.log(
      `Deepgram response: duration=${result.metadata?.duration}s, ` +
        `utterances=${result.results?.utterances?.length || 0}, ` +
        `words=${result.results?.channels?.[0]?.alternatives?.[0]?.words?.length || 0}`,
    );

    // duration 在 metadata 中，channels 和 utterances 在 results 中
    return {
      duration: result.metadata?.duration || 0,
      channels: result.results?.channels || [],
      utterances: result.results?.utterances || [],
    } as DeepgramResult;
  }

  /**
   * 验证 Webhook 签名
   * Deepgram 使用 HMAC SHA256 签名
   * 签名格式: sha256=<signature>
   */
  verifyWebhookSignature(payload: string | Buffer, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      this.logger.warn('Missing signature or secret for webhook verification');
      return false;
    }

    try {
      // 提取签名值（格式: sha256=xxx 或直接是签名）
      const providedSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

      // 计算期望的签名
      const hmac = createHmac('sha256', secret);
      hmac.update(typeof payload === 'string' ? payload : payload.toString());
      const expectedSig = hmac.digest('hex');

      // 使用时间安全比较防止时序攻击
      const providedBuffer = Buffer.from(providedSig, 'hex');
      const expectedBuffer = Buffer.from(expectedSig, 'hex');

      if (providedBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return timingSafeEqual(providedBuffer, expectedBuffer);
    } catch (err) {
      this.logger.error(`Webhook signature verification error: ${err}`);
      return false;
    }
  }

  /**
   * 获取 Webhook Secret（从配置中）
   */
  getWebhookSecret(): string {
    return this.configService.get<string>('deepgram.webhookSecret') || '';
  }
}
