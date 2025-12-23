import { Module, Global } from '@nestjs/common';
import { YouTubeService } from './youtube.service';
import { YouTubeDownloaderService } from './youtube-downloader.service';
import { YouTubeTranscriptService } from './youtube-transcript.service';

@Global()
@Module({
  providers: [YouTubeService, YouTubeDownloaderService, YouTubeTranscriptService],
  exports: [YouTubeService, YouTubeDownloaderService, YouTubeTranscriptService],
})
export class YouTubeModule {}
