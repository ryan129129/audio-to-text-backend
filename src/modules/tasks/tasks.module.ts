import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksProcessor } from './tasks.processor';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { TASKS_QUEUE } from './constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: TASKS_QUEUE,
    }),
    AuthModule,
    BillingModule,
    TranscriptsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService, TasksProcessor],
  exports: [TasksService],
})
export class TasksModule {}
