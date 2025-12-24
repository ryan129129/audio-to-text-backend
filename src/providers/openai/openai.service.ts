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
      this.logger.warn('OPENAI_API_KEY not configured, LLM merge will be disabled');
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
    options: {
      language?: string;      // 源语言
      translateTo?: string;   // 翻译目标语言（可选）
    } = {},
  ): Promise<TranscriptSegment[]> {
    if (!this.client) {
      this.logger.warn('OpenAI not available, returning original segments');
      return segments;
    }

    if (segments.length === 0) {
      return [];
    }

    const { language, translateTo } = options;

    // 构建输入数据（简化格式减少 token）
    const inputData = segments.map((seg, idx) => ({
      i: idx,           // 索引
      s: seg.start,     // 开始时间
      e: seg.end,       // 结束时间
      t: seg.text,      // 文本
      sp: seg.speaker,  // 说话人
    }));

    const systemPrompt = this.buildMergePrompt(language, translateTo);

    try {
      this.logger.log(`Merging ${segments.length} segments with LLM...`);

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(inputData) },
        ],
        temperature: 0.1,  // 低温度，更确定性的输出
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const result = JSON.parse(content);
      const mergedSegments = this.parseResult(result, segments);

      this.logger.log(
        `LLM merged ${segments.length} -> ${mergedSegments.length} segments, ` +
        `tokens: ${response.usage?.total_tokens || 'unknown'}`
      );

      return mergedSegments;
    } catch (error) {
      this.logger.error(`LLM merge failed: ${error}`);
      // 失败时返回原始 segments
      return segments;
    }
  }

  /**
   * 构建合并 Prompt
   */
  private buildMergePrompt(language?: string, translateTo?: string): string {
    let prompt = `你是一个专业的字幕处理助手。你的任务是将碎片化的转录文本合并成完整的句子。

## 输入格式
JSON 数组，每个元素包含：
- i: 片段索引
- s: 开始时间（秒）
- e: 结束时间（秒）
- t: 文本内容
- sp: 说话人（可能为 null）

## 输出格式
返回 JSON 对象，格式为：
{
  "segments": [
    {
      "start": 开始时间（使用合并后第一个片段的开始时间）,
      "end": 结束时间（使用合并后最后一个片段的结束时间）,
      "text": "合并后的完整句子",
      "speaker": 说话人或 null
    }
  ]
}

## 合并规则
1. 将属于同一句话的碎片合并为完整句子
2. 根据语义和标点符号判断句子边界
3. 如果有说话人信息，不同说话人的内容不要合并
4. 保持原始的时间顺序
5. 修正明显的语音识别错误（如 "我是 老高" 应为 "我是老高"）
6. 去除不必要的空格，但保留英文单词之间的空格`;

    if (translateTo) {
      prompt += `
7. 将文本翻译成${translateTo}`;
    }

    prompt += `

## 注意事项
- 只返回 JSON，不要添加任何解释
- 确保时间戳的准确性
- 保持内容的完整性，不要遗漏任何信息`;

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
      this.logger.warn('Invalid LLM response format, using original segments');
      return originalSegments;
    }

    return result.segments.map((seg: any) => ({
      start: typeof seg.start === 'number' ? seg.start : 0,
      end: typeof seg.end === 'number' ? seg.end : 0,
      text: typeof seg.text === 'string' ? seg.text : '',
      speaker: seg.speaker || null,
    }));
  }
}
