import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedUrlResult {
  upload_url: string;
  fields?: Record<string, string>;
  key: string;
  public_url: string;
}

@Injectable()
export class R2Service implements OnModuleInit {
  private readonly logger = new Logger(R2Service.name);
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const endpoint = this.configService.get<string>('r2.endpoint');
    const accessKey = this.configService.get<string>('r2.accessKey');
    const secretKey = this.configService.get<string>('r2.secretKey');
    this.bucket = this.configService.get<string>('r2.bucket') || '';
    this.publicUrl = this.configService.get<string>('r2.publicUrl') || '';

    if (!endpoint || !accessKey || !secretKey) {
      this.logger.warn('R2 configuration missing');
      return;
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
    });

    this.logger.log('R2 client initialized');
  }

  /**
   * 生成预签名上传 URL
   */
  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = 3600,
  ): Promise<PresignedUrlResult> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const upload_url = await getSignedUrl(this.client, command, { expiresIn });

    return {
      upload_url,
      key,
      public_url: `${this.publicUrl}/${key}`,
    };
  }

  /**
   * 生成预签名下载 URL
   */
  async getPresignedDownloadUrl(
    key: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  /**
   * 上传文件
   */
  async uploadFile(
    key: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    });

    await this.client.send(command);
    return `${this.publicUrl}/${key}`;
  }

  /**
   * 生成存储路径
   */
  generateKey(prefix: string, filename: string): string {
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = filename.split('.').pop() || '';
    return `${prefix}/${timestamp}-${randomStr}.${ext}`;
  }
}
