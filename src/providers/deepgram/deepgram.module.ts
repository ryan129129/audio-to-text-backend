import { Module, Global } from '@nestjs/common';
import { DeepgramService } from './deepgram.service';

@Global()
@Module({
  providers: [DeepgramService],
  exports: [DeepgramService],
})
export class DeepgramModule {}
