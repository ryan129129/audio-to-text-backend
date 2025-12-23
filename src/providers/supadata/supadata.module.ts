import { Module, Global } from '@nestjs/common';
import { SupadataService } from './supadata.service';

@Global()
@Module({
  providers: [SupadataService],
  exports: [SupadataService],
})
export class SupadataModule {}
