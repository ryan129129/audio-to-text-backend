import { Module } from '@nestjs/common';
import { TranscriptsService } from './transcripts.service';

@Module({
  providers: [TranscriptsService],
  exports: [TranscriptsService],
})
export class TranscriptsModule {}
