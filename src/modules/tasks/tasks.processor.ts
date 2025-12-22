import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TaskProcessorService, TaskJobData } from './task-processor.service';
import { TASKS_QUEUE } from './constants';

@Processor(TASKS_QUEUE)
export class TasksProcessor extends WorkerHost {
  private readonly logger = new Logger(TasksProcessor.name);

  constructor(private taskProcessorService: TaskProcessorService) {
    super();
  }

  async process(job: Job<TaskJobData>): Promise<void> {
    await this.taskProcessorService.processTask(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }
}
