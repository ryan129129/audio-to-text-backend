import { Injectable, BadRequestException } from '@nestjs/common';
import { R2Service } from '../../providers/r2/r2.service';
import { GetUploadUrlDto, UploadUrlResponseDto } from './dto/upload-url.dto';

// 允许的 MIME 类型
const ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
];

@Injectable()
export class UploadService {
  constructor(private r2Service: R2Service) {}

  /**
   * 获取预签名上传 URL
   */
  async getUploadUrl(dto: GetUploadUrlDto): Promise<UploadUrlResponseDto> {
    // 校验 MIME 类型
    if (!ALLOWED_MIME_TYPES.includes(dto.content_type)) {
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: `Unsupported content type: ${dto.content_type}`,
        details: { allowed: ALLOWED_MIME_TYPES },
      });
    }

    // 生成存储路径
    const key = this.r2Service.generateKey('uploads', dto.filename);

    // 获取预签名 URL
    const result = await this.r2Service.getPresignedUploadUrl(
      key,
      dto.content_type,
      3600, // 1小时有效期
    );

    return {
      upload_url: result.upload_url,
      key: result.key,
      public_url: result.public_url,
    };
  }
}
