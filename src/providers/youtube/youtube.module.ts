import { Module, Global } from '@nestjs/common';
import { YouTubeService } from './youtube.service';

@Global()
@Module({
  providers: [YouTubeService],
  exports: [YouTubeService],
})
export class YouTubeModule {}
