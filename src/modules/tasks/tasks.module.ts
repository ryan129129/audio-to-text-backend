import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksProcessor } from './tasks.processor';
import { TaskProcessorService } from './task-processor.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { TASKS_QUEUE } from './constants';

const redisEnabled = process.env.REDIS_ENABLED === 'true';

@Module({
  imports: [
    ...(redisEnabled
      ? [
          BullModule.registerQueue({
            name: TASKS_QUEUE,
          }),
        ]
      : []),
    AuthModule,
    BillingModule,
    TranscriptsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService, TaskProcessorService, ...(redisEnabled ? [TasksProcessor] : [])],
  exports: [TasksService, TaskProcessorService],
})
export class TasksModule {}
