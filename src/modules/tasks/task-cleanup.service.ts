import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { TaskStatus } from '../../database/entities';

/**
 * 任务清理服务
 * 自动检测并标记卡住的任务为失败
 */
@Injectable()
export class TaskCleanupService implements OnModuleInit {
  private readonly logger = new Logger(TaskCleanupService.name);
  // 任务超时时间（分钟）- 超过此时间的 processing 状态任务视为卡住
  private readonly TASK_TIMEOUT_MINUTES = 10;

  constructor(private supabaseService: SupabaseService) {}

  /**
   * 应用启动时执行一次清理
   */
  async onModuleInit() {
    this.logger.log('Running initial stuck task cleanup...');
    await this.cleanupStuckTasks();
  }

  /**
   * 每 5 分钟检查并清理卡住的任务
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    await this.cleanupStuckTasks();
  }

  /**
   * 清理卡住的任务
   * 将超过 TASK_TIMEOUT_MINUTES 分钟仍处于 processing 状态的任务标记为失败
   */
  async cleanupStuckTasks(): Promise<number> {
    const supabase = this.supabaseService.getClient();
    const timeoutThreshold = new Date(Date.now() - this.TASK_TIMEOUT_MINUTES * 60 * 1000);

    // 查找卡住的任务
    const { data: stuckTasks, error: selectError } = await supabase
      .from('tasks')
      .select('id, status, updated_at')
      .eq('status', TaskStatus.PROCESSING)
      .lt('updated_at', timeoutThreshold.toISOString());

    if (selectError) {
      this.logger.error(`Failed to query stuck tasks: ${selectError.message}`);
      return 0;
    }

    if (!stuckTasks || stuckTasks.length === 0) {
      this.logger.debug('No stuck tasks found');
      return 0;
    }

    this.logger.warn(`Found ${stuckTasks.length} stuck tasks, marking as failed...`);

    // 批量更新为失败状态
    const taskIds = stuckTasks.map((t) => t.id);
    const { error: updateError } = await supabase
      .from('tasks')
      .update({
        status: TaskStatus.FAILED,
        error: `任务处理超时（超过 ${this.TASK_TIMEOUT_MINUTES} 分钟），请重试`,
        updated_at: new Date().toISOString(),
      })
      .in('id', taskIds);

    if (updateError) {
      this.logger.error(`Failed to update stuck tasks: ${updateError.message}`);
      return 0;
    }

    this.logger.log(`Marked ${taskIds.length} stuck tasks as failed: ${taskIds.join(', ')}`);
    return taskIds.length;
  }
}
