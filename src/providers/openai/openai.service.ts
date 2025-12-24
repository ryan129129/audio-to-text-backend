import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

// 转录片段类型
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

// LLM 处理模式
type ProcessMode = 'merge' | 'translate';

@Injectable()
export class OpenAIService {
  private readonly logger = new Logger(OpenAIService.name);
  private client: OpenAI | null = null;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      this.logger.log('OpenAI client initialized');
    } else {
      this.logger.warn('OPENAI_API_KEY not configured, LLM features will be disabled');
    }
  }

  /**
   * 检查 OpenAI 服务是否可用
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * 合并碎片化的转录 segments
   * 使用 LLM 智能合并，保留时间戳
   */
  async mergeTranscriptSegments(
    segments: TranscriptSegment[],
    options: { language?: string } = {},
  ): Promise<TranscriptSegment[]> {
    return this.processSegments(segments, 'merge', options.language);
  }

  /**
   * 翻译转录 segments
   * 保持原有结构（时间戳、说话人），只翻译文本
   */
  async translateSegments(
    segments: TranscriptSegment[],
    targetLanguage: string,
  ): Promise<TranscriptSegment[]> {
    return this.processSegments(segments, 'translate', targetLanguage);
  }

  /**
   * 统一的 segments 处理方法
   * @param segments 输入 segments
   * @param mode 处理模式：merge（合并+可选翻译）或 translate（仅翻译）
   * @param language 目标语言
   */
  private async processSegments(
    segments: TranscriptSegment[],
    mode: ProcessMode,
    language?: string,
  ): Promise<TranscriptSegment[]> {
    if (!this.client) {
      throw new Error('OpenAI service not available. Please configure OPENAI_API_KEY.');
    }

    if (segments.length === 0) {
      return [];
    }

    // 构建输入数据
    const inputData = segments.map((seg, idx) => ({
      i: idx,
      s: seg.start,
      e: seg.end,
      t: seg.text,
      sp: seg.speaker,
    }));

    const systemPrompt = this.buildPrompt(mode, language);
    const modeLabel = mode === 'merge' ? '合并' : '翻译';

    try {
      this.logger.log(`${modeLabel} ${segments.length} segments${language ? ` to ${language}` : ''}...`);

      const response = await this.client.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(inputData) },
        ],
        temperature: mode === 'merge' ? 0.1 : 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const result = JSON.parse(content);
      const outputSegments = this.parseResult(result, segments);

      this.logger.log(
        `${modeLabel}完成: ${segments.length} -> ${outputSegments.length} segments, ` +
        `tokens: ${response.usage?.total_tokens || 'unknown'}`
      );

      return outputSegments;
    } catch (error) {
      this.logger.error(`${modeLabel}失败: ${error}`);
      throw new Error(`${modeLabel}失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 构建 Prompt
   */
  private buildPrompt(mode: ProcessMode, language?: string): string {
    if (mode === 'translate') {
      return `你是一个专业的翻译助手。将字幕文本翻译成${language || '中文'}。

## 输入格式
JSON 数组，每个元素包含：i(索引), s(开始时间), e(结束时间), t(文本), sp(说话人)

## 输出格式
{
  "segments": [
    { "start": 开始时间, "end": 结束时间, "text": "翻译后的文本", "speaker": 说话人或null }
  ]
}

## 规则
1. 保持时间戳不变
2. 保持说话人不变
3. 只翻译 text 字段
4. 如果原文已是目标语言，直接返回原文
5. 保持原文的语气和风格`;
    }

    // merge 模式
    let prompt = `你是一个专业的字幕处理助手。将碎片化的转录文本合并成完整的句子。

## 输入格式
JSON 数组，每个元素包含：i(索引), s(开始时间), e(结束时间), t(文本), sp(说话人)

## 输出格式
{
  "segments": [
    { "start": 合并后第一个片段的开始时间, "end": 合并后最后一个片段的结束时间, "text": "合并后的完整句子", "speaker": 说话人或null }
  ]
}

## 合并规则
1. 将属于同一句话的碎片合并为完整句子
2. 根据语义和标点符号判断句子边界
3. 不同说话人的内容不要合并
4. 保持时间顺序
5. 修正语音识别错误（如 "我是 老高" → "我是老高"）
6. 去除中文间多余空格，保留英文单词间空格`;

    if (language) {
      prompt += `
7. 将文本翻译成${language}`;
    }

    return prompt;
  }

  /**
   * 解析 LLM 返回结果
   */
  private parseResult(
    result: any,
    originalSegments: TranscriptSegment[],
  ): TranscriptSegment[] {
    if (!result.segments || !Array.isArray(result.segments)) {
      this.logger.warn('Invalid LLM response format');
      throw new Error('Invalid LLM response format');
    }

    return result.segments.map((seg: any) => ({
      start: typeof seg.start === 'number' ? seg.start : 0,
      end: typeof seg.end === 'number' ? seg.end : 0,
      text: typeof seg.text === 'string' ? seg.text : '',
      speaker: seg.speaker || null,
    }));
  }
}
