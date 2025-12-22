import { Module, Global } from '@nestjs/common';
import { YouTubeService } from './youtube.service';
import { YouTubeDownloaderService } from './youtube-downloader.service';

@Global()
@Module({
  providers: [YouTubeService, YouTubeDownloaderService],
  exports: [YouTubeService, YouTubeDownloaderService],
})
export class YouTubeModule {}
