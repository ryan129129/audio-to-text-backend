import { Controller, Post, Body, SetMetadata } from '@nestjs/common';
import { UploadService } from './upload.service';
import { GetUploadUrlDto, UploadUrlResponseDto } from './dto/upload-url.dto';
import { ALLOW_ANONYMOUS_KEY } from '../../common/guards/auth.guard';

@Controller('upload-url')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * POST /api/upload-url
   * 获取 R2 直传凭证
   */
  @Post()
  @SetMetadata(ALLOW_ANONYMOUS_KEY, true)
  async getUploadUrl(@Body() dto: GetUploadUrlDto): Promise<UploadUrlResponseDto> {
    return this.uploadService.getUploadUrl(dto);
  }
}
