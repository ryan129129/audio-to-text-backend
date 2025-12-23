import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { unlinkSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { R2Service } from '../r2/r2.service';

export interface DownloadResult {
  audioUrl: string; // R2 上的 URL
  duration: number; // 时长（秒）
  title: string;
}

@Injectable()
export class YouTubeDownloaderService {
  private readonly logger = new Logger(YouTubeDownloaderService.name);
  private readonly tempDir: string;
  private readonly cookiesPath = '/app/cookies/youtube.txt';

  constructor(
    private configService: ConfigService,
    private r2Service: R2Service,
  ) {
    // 临时目录用于存放下载的音频
    this.tempDir = join(process.cwd(), 'tmp', 'youtube');
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 下载 YouTube 视频的音频并上传到 R2
   */
  async downloadAndUpload(youtubeUrl: string, taskId: string): Promise<DownloadResult> {
    const outputId = uuidv4();
    const outputPath = join(this.tempDir, `${outputId}.m4a`);
    const infoPath = join(this.tempDir, `${outputId}.info.json`);

    try {
      // 1. 使用 yt-dlp 下载音频
      this.logger.log(`Downloading audio from ${youtubeUrl}`);
      await this.runYtDlp(youtubeUrl, outputPath, infoPath);

      // 2. 读取视频信息
      const info = await this.readVideoInfo(infoPath);

      // 3. 上传到 R2
      this.logger.log(`Uploading audio to R2`);
      const r2Key = `youtube/${taskId}/${outputId}.m4a`;
      const audioUrl = await this.uploadToR2(outputPath, r2Key);

      this.logger.log(`Audio uploaded to ${audioUrl}`);

      return {
        audioUrl,
        duration: info.duration || 0,
        title: info.title || '',
      };
    } finally {
      // 清理临时文件
      this.cleanup(outputPath, infoPath);
    }
  }

  /**
   * 运行 yt-dlp 命令
   */
  private runYtDlp(url: string, outputPath: string, infoPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '--extract-audio',
        '--audio-format', 'm4a',
        '--audio-quality', '0',
        '--output', outputPath,
        '--write-info-json',
        '--no-playlist',
        '--no-warnings',
        '--extractor-args', 'youtube:player_client=android,web',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ];

      // 如果存在 cookies 文件，复制到临时目录（因为 yt-dlp 需要写入权限）
      let tempCookiesPath: string | null = null;
      if (existsSync(this.cookiesPath)) {
        tempCookiesPath = join(this.tempDir, `cookies-${uuidv4()}.txt`);
        try {
          copyFileSync(this.cookiesPath, tempCookiesPath);
          this.logger.log(`Using cookies file (copied to temp): ${tempCookiesPath}`);
          args.push('--cookies', tempCookiesPath);
        } catch (err) {
          this.logger.warn(`Failed to copy cookies file: ${err}`);
        }
      }

      args.push(url);

      const proc = spawn('yt-dlp', args);

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        // 清理临时 cookies 文件
        if (tempCookiesPath && existsSync(tempCookiesPath)) {
          try {
            unlinkSync(tempCookiesPath);
          } catch (e) {
            this.logger.warn(`Failed to cleanup temp cookies: ${e}`);
          }
        }

        if (code === 0) {
          resolve();
        } else {
          this.logger.error(`yt-dlp exited with code ${code}: ${stderr}`);
          reject(new Error(`yt-dlp failed: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        this.logger.error(`yt-dlp spawn error: ${err.message}`);
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });

      // 超时处理（10分钟）
      setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('yt-dlp timeout'));
      }, 10 * 60 * 1000);
    });
  }

  /**
   * 读取视频信息
   */
  private async readVideoInfo(infoPath: string): Promise<{ duration: number; title: string }> {
    try {
      // yt-dlp 会创建 .info.json 文件
      const actualPath = infoPath.replace('.info.json', '.m4a.info.json');
      if (existsSync(actualPath)) {
        const content = await import('fs').then(fs =>
          fs.promises.readFile(actualPath, 'utf-8')
        );
        const info = JSON.parse(content);
        return {
          duration: info.duration || 0,
          title: info.title || '',
        };
      }
      // 尝试原始路径
      if (existsSync(infoPath)) {
        const content = await import('fs').then(fs =>
          fs.promises.readFile(infoPath, 'utf-8')
        );
        const info = JSON.parse(content);
        return {
          duration: info.duration || 0,
          title: info.title || '',
        };
      }
    } catch (err) {
      this.logger.warn(`Failed to read video info: ${err}`);
    }
    return { duration: 0, title: '' };
  }

  /**
   * 上传文件到 R2
   */
  private async uploadToR2(filePath: string, key: string): Promise<string> {
    const fileBuffer = await import('fs').then(fs =>
      fs.promises.readFile(filePath)
    );
    return this.r2Service.uploadFile(key, fileBuffer, 'audio/mp4');
  }

  /**
   * 清理临时文件
   */
  private cleanup(...paths: string[]): void {
    for (const p of paths) {
      try {
        if (existsSync(p)) {
          unlinkSync(p);
        }
        // 也尝试删除 .info.json 变体
        const infoVariant = p.replace('.m4a', '.m4a.info.json');
        if (existsSync(infoVariant)) {
          unlinkSync(infoVariant);
        }
      } catch (err) {
        this.logger.warn(`Failed to cleanup ${p}: ${err}`);
      }
    }
  }
}
