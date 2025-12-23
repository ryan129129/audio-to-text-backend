import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { unlinkSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
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
    // 使用系统 /tmp 目录（Cloud Run 中可写）
    this.tempDir = '/tmp/youtube';
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 下载 YouTube 视频的音频并上传到 R2
   */
  async downloadAndUpload(youtubeUrl: string, taskId: string): Promise<DownloadResult> {
    const outputId = uuidv4();
    // 使用模板让 yt-dlp 自动填充扩展名
    const outputTemplate = join(this.tempDir, `${outputId}.%(ext)s`);
    const infoPath = join(this.tempDir, `${outputId}.info.json`);

    let actualOutputPath = '';
    try {
      // 1. 使用 yt-dlp 下载音频（不转码，直接下载原始格式）
      this.logger.log(`Downloading audio from ${youtubeUrl}`);
      const downloadResult = await this.runYtDlp(youtubeUrl, outputTemplate, infoPath);
      actualOutputPath = downloadResult.outputPath;

      // 2. 读取视频信息
      const info = await this.readVideoInfo(infoPath);

      // 3. 上传到 R2
      this.logger.log(`Uploading audio to R2`);
      const ext = actualOutputPath.split('.').pop() || 'webm';
      const r2Key = `youtube/${taskId}/${outputId}.${ext}`;
      const contentType = this.getContentType(ext);
      const audioUrl = await this.uploadToR2(actualOutputPath, r2Key, contentType);

      this.logger.log(`Audio uploaded to ${audioUrl}`);

      return {
        audioUrl,
        duration: info.duration || 0,
        title: info.title || '',
      };
    } finally {
      // 清理临时文件
      this.cleanup(actualOutputPath, infoPath);
    }
  }

  /**
   * 运行 yt-dlp 命令
   * @returns 实际输出文件路径
   */
  private runYtDlp(url: string, outputTemplate: string, infoPath: string): Promise<{ outputPath: string }> {
    return new Promise((resolve, reject) => {
      // 直接下载最佳音频格式，不转码（避免 ffmpeg 耗时）
      const args = [
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '--output', outputTemplate,
        '--write-info-json',
        '--no-playlist',
        '--no-warnings',
        '--print', 'after_move:filepath',  // 输出实际文件路径
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ];

      // 如果存在 cookies 文件，复制到临时目录（因为 yt-dlp 需要写入权限）
      let tempCookiesPath: string | null = null;
      if (existsSync(this.cookiesPath)) {
        tempCookiesPath = join(this.tempDir, `cookies-${uuidv4()}.txt`);
        try {
          copyFileSync(this.cookiesPath, tempCookiesPath);
          chmodSync(tempCookiesPath, 0o666);  // 确保可写
          this.logger.log(`Using cookies file (copied to temp): ${tempCookiesPath}`);
          args.push('--cookies', tempCookiesPath);
        } catch (err) {
          this.logger.warn(`Failed to copy cookies file: ${err}`);
        }
      }

      args.push(url);

      const proc = spawn('yt-dlp', args);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

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
          // 从 stdout 获取实际文件路径
          const outputPath = stdout.trim().split('\n').pop() || '';
          this.logger.log(`yt-dlp downloaded to: ${outputPath}`);
          resolve({ outputPath });
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
  private async uploadToR2(filePath: string, key: string, contentType: string): Promise<string> {
    const fileBuffer = await import('fs').then(fs =>
      fs.promises.readFile(filePath)
    );
    return this.r2Service.uploadFile(key, fileBuffer, contentType);
  }

  /**
   * 根据扩展名获取 Content-Type
   */
  private getContentType(ext: string): string {
    const types: Record<string, string> = {
      'm4a': 'audio/mp4',
      'webm': 'audio/webm',
      'opus': 'audio/opus',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'wav': 'audio/wav',
    };
    return types[ext.toLowerCase()] || 'audio/mpeg';
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
