import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class GetUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  content_type: string;

  @IsBoolean()
  @IsOptional()
  is_trial?: boolean;
}

export class UploadUrlResponseDto {
  upload_url: string;
  fields?: Record<string, string>;
  key: string;
  public_url: string;
}
