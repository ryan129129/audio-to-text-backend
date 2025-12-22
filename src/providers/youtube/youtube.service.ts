import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface YouTubeVideoInfo {
  id: string;
  title: string;
  duration: number; // 秒
  thumbnail: string;
}

@Injectable()
export class YouTubeService implements OnModuleInit {
  private readonly logger = new Logger(YouTubeService.name);
  private apiKey: string;
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.apiKey = this.configService.get<string>('youtube.apiKey') || '';
    if (!this.apiKey) {
      this.logger.warn('YouTube API key not configured');
    } else {
      this.logger.log('YouTube service initialized');
    }
  }

  /**
   * 从 URL 提取视频 ID
   */
  extractVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * 获取视频信息（包括时长）
   */
  async getVideoInfo(videoId: string): Promise<YouTubeVideoInfo | null> {
    const params = new URLSearchParams({
      part: 'contentDetails,snippet',
      id: videoId,
      key: this.apiKey,
    });

    const response = await fetch(`${this.baseUrl}/videos?${params.toString()}`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`YouTube API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const video = data.items?.[0];

    if (!video) {
      return null;
    }

    const duration = this.parseDuration(video.contentDetails.duration);

    return {
      id: videoId,
      title: video.snippet.title,
      duration,
      thumbnail: video.snippet.thumbnails?.high?.url || '',
    };
  }

  /**
   * 解析 ISO 8601 时长格式
   */
  private parseDuration(duration: string): number {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);

    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * 检查时长是否在限制范围内
   */
  isDurationWithinLimit(durationSec: number, limitMinutes: number): boolean {
    return durationSec <= limitMinutes * 60;
  }
}
