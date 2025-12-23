import { Injectable, Logger } from '@nestjs/common';
import { getSubtitles } from 'youtube-caption-extractor';
import { YouTubeService } from './youtube.service';

// youtube-caption-extractor 返回的数据结构
interface CaptionItem {
  start: string;  // 开始时间（秒，字符串格式）
  dur: string;    // 持续时间（秒，字符串格式）
  text: string;
}

export interface TranscriptResult {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }>;
  fullText: string;
  language: string;
  duration: number;
}

@Injectable()
export class YouTubeTranscriptService {
  private readonly logger = new Logger(YouTubeTranscriptService.name);

  constructor(private youtubeService: YouTubeService) {}

  /**
   * 获取 YouTube 视频字幕
   * @param videoUrl YouTube 视频 URL
   * @returns 字幕结果，如果没有字幕则返回 null
   */
  async getTranscript(videoUrl: string): Promise<TranscriptResult | null> {
    const videoId = this.youtubeService.extractVideoId(videoUrl);
    if (!videoId) {
      this.logger.error(`Invalid YouTube URL: ${videoUrl}`);
      return null;
    }

    try {
      this.logger.log(`Fetching transcript for video: ${videoId}`);

      // 获取字幕
      const captionItems: CaptionItem[] = await getSubtitles({ videoID: videoId });

      if (!captionItems || captionItems.length === 0) {
        this.logger.warn(`No transcript available for video: ${videoId}`);
        return null;
      }

      // 转换为统一格式
      const segments = captionItems.map((item) => {
        const start = parseFloat(item.start);
        const dur = parseFloat(item.dur);
        return {
          start,
          end: start + dur,
          text: item.text.replace(/\n/g, ' '),  // 移除换行符
          speaker: null,  // YouTube 字幕没有说话人信息
        };
      });

      // 计算总时长
      const lastSegment = segments[segments.length - 1];
      const duration = lastSegment ? lastSegment.end : 0;

      // 合并全文
      const fullText = segments.map((s) => s.text).join(' ');

      this.logger.log(`Successfully fetched transcript: ${segments.length} segments, ${duration.toFixed(1)}s`);

      return {
        segments,
        fullText,
        language: 'auto',
        duration,
      };
    } catch (error: any) {
      // 检查是否是"没有字幕"的错误
      if (error.message?.includes('disabled') ||
          error.message?.includes('not available') ||
          error.message?.includes('No captions') ||
          error.message?.includes('Could not find')) {
        this.logger.warn(`Transcript not available for video ${videoId}: ${error.message}`);
        return null;
      }

      this.logger.error(`Failed to fetch transcript for video ${videoId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检查视频是否有字幕
   */
  async hasTranscript(videoUrl: string): Promise<boolean> {
    try {
      const result = await this.getTranscript(videoUrl);
      return result !== null;
    } catch {
      return false;
    }
  }
}
