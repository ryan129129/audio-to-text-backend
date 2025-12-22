import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { YouTubeService } from '../../providers/youtube/youtube.service';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { CurrentUser } from '../../common/interfaces/response.interface';
import {
  Task,
  TaskStatus,
  TaskType,
  SourceType,
  Priority,
  Engine,
} from '../../database/entities';
import { CreateTaskDto, CreateTaskResponseDto } from './dto/create-task.dto';
import { TaskResponseDto, TaskListResponseDto, GetTasksQueryDto } from './dto/task.dto';
import { TASKS_QUEUE } from './constants';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  private readonly maxTrialMinutes: number;
  private readonly pollInterval: number;

  constructor(
    @InjectQueue(TASKS_QUEUE) private tasksQueue: Queue,
    private supabaseService: SupabaseService,
    private youtubeService: YouTubeService,
    private authService: AuthService,
    private billingService: BillingService,
    private configService: ConfigService,
  ) {
    this.maxTrialMinutes = this.configService.get<number>('trial.maxDurationMinutes') || 30;
    this.pollInterval = this.configService.get<number>('task.pollIntervalSeconds') || 5;
  }

  /**
   * 创建任务
   */
  async createTask(
    dto: CreateTaskDto,
    user: CurrentUser,
  ): Promise<CreateTaskResponseDto> {
    const supabase = this.supabaseService.getClient();
    const isTrial = dto.is_trial ?? false;
    const isAnonymous = !user.isAuthenticated;

    // 1. 校验体验限制
    if (isTrial || isAnonymous) {
      const hasUsed = await this.authService.hasUsedTrial(user.id, user.anonId);
      if (hasUsed) {
        throw new ForbiddenException({
          code: 'TRIAL_EXHAUSTED',
          message: '体验机会已用完，请付费使用',
        });
      }

      // YouTube 链接需要校验时长
      if (dto.source_type === SourceType.YOUTUBE) {
        const videoId = this.youtubeService.extractVideoId(dto.source_url);
        if (!videoId) {
          throw new BadRequestException({
            code: 'INVALID_INPUT',
            message: '无效的 YouTube 链接',
          });
        }

        const videoInfo = await this.youtubeService.getVideoInfo(videoId);
        if (!videoInfo) {
          throw new BadRequestException({
            code: 'INVALID_INPUT',
            message: '无法获取视频信息',
          });
        }

        const durationMinutes = videoInfo.duration / 60;
        if (durationMinutes > this.maxTrialMinutes) {
          throw new ForbiddenException({
            code: 'DURATION_EXCEEDED',
            message: `体验仅限 ${this.maxTrialMinutes} 分钟以内的视频，当前视频时长 ${Math.ceil(durationMinutes)} 分钟`,
          });
        }
      }
    }

    // 2. 已登录用户检查余额
    if (user.isAuthenticated && !isTrial) {
      const balance = await this.billingService.getBalance(user.id!);
      if (!balance || balance.minutes_balance <= 0) {
        throw new ForbiddenException({
          code: 'INSUFFICIENT_BALANCE',
          message: '余额不足，请充值',
        });
      }
    }

    // 3. 检查并发限制（同一用户/anon_id 仅一条未完成任务）
    const pendingTasksQuery = supabase
      .from('tasks')
      .select('id')
      .in('status', [TaskStatus.PENDING, TaskStatus.PROCESSING]);

    if (user.id) {
      pendingTasksQuery.eq('user_id', user.id);
    } else if (user.anonId) {
      pendingTasksQuery.eq('anon_id', user.anonId);
    }

    const { data: pendingTasks } = await pendingTasksQuery;
    if (pendingTasks && pendingTasks.length > 0) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: '您有正在处理的任务，请等待完成后再提交',
      });
    }

    // 4. 创建任务
    const taskId = uuidv4();
    const priority = isTrial || isAnonymous ? Priority.FREE : Priority.PAID;

    const task: Partial<Task> = {
      id: taskId,
      user_id: user.id,
      anon_id: user.anonId,
      task_type: dto.task_type || TaskType.TRANSCRIPTION,
      source_type: dto.source_type,
      source_url: dto.source_url,
      size_bytes: dto.size_bytes || null,
      is_trial: isTrial || isAnonymous,
      priority,
      status: TaskStatus.PENDING,
      engine: Engine.DEEPGRAM,
      params: dto.params || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('tasks').insert(task);
    if (error) {
      this.logger.error(`Failed to create task: ${error.message}`);
      throw new Error('创建任务失败');
    }

    // 5. 入队
    await this.tasksQueue.add(
      'transcribe',
      {
        task_id: taskId,
        task_type: task.task_type,
        source_type: task.source_type,
        source_url: task.source_url,
        engine: task.engine,
        params: task.params,
      },
      {
        priority: priority === Priority.PAID ? 1 : 10,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    );

    this.logger.log(`Task created and queued: ${taskId}`);

    return {
      task_id: taskId,
      status: TaskStatus.PENDING,
      retry_after: this.pollInterval,
    };
  }

  /**
   * 获取任务详情
   */
  async getTask(taskId: string, user: CurrentUser): Promise<TaskResponseDto> {
    const supabase = this.supabaseService.getClient();

    // 获取任务
    const { data: task, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (error || !task) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '任务不存在',
      });
    }

    // 权限校验
    const isOwner =
      (user.id && task.user_id === user.id) ||
      (user.anonId && task.anon_id === user.anonId);

    if (!isOwner) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: '无权访问此任务',
      });
    }

    // 单独获取 transcript（避免 join 问题）
    let transcript = null;
    if (task.status === TaskStatus.SUCCEEDED) {
      const { data: transcriptData } = await supabase
        .from('transcripts')
        .select('*')
        .eq('task_id', taskId)
        .single();
      transcript = transcriptData;
    }

    return this.formatTaskResponse(task, transcript);
  }

  /**
   * 获取任务列表
   */
  async getTasks(
    query: GetTasksQueryDto,
    user: CurrentUser,
  ): Promise<TaskListResponseDto> {
    const supabase = this.supabaseService.getClient();
    const limit = query.limit || 20;

    let queryBuilder = supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    // 按用户过滤
    if (user.id) {
      queryBuilder = queryBuilder.eq('user_id', user.id);
    } else if (user.anonId) {
      queryBuilder = queryBuilder.eq('anon_id', user.anonId);
    } else {
      return { items: [], next_cursor: null };
    }

    // 状态过滤
    if (query.status) {
      queryBuilder = queryBuilder.eq('status', query.status);
    }

    // 游标分页
    if (query.cursor) {
      queryBuilder = queryBuilder.lt('created_at', query.cursor);
    }

    const { data: tasks, error } = await queryBuilder;

    if (error) {
      this.logger.error(`Failed to fetch tasks: ${error.message}`);
      throw new Error('获取任务列表失败');
    }

    const hasMore = tasks && tasks.length > limit;
    const items = hasMore ? tasks.slice(0, limit) : tasks || [];
    const nextCursor = hasMore ? items[items.length - 1]?.created_at : null;

    return {
      items: items.map((task) => this.formatTaskResponse(task)),
      next_cursor: nextCursor,
    };
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    updates: Partial<Task> = {},
  ): Promise<void> {
    const supabase = this.supabaseService.getClient();

    const { error } = await supabase
      .from('tasks')
      .update({
        status,
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    if (error) {
      this.logger.error(`Failed to update task status: ${error.message}`);
    }
  }

  /**
   * 格式化任务响应
   */
  private formatTaskResponse(task: any, transcript?: any): TaskResponseDto {
    const response: TaskResponseDto = {
      task_id: task.id,
      status: task.status,
      source_type: task.source_type,
      priority: task.priority,
      engine: task.engine,
      duration_sec: task.duration_sec,
      cost_minutes: task.cost_minutes,
      error: task.error ? { code: 'ENGINE_ERROR', message: task.error } : null,
      created_at: task.created_at,
    };

    // 进行中的任务添加 retry_after
    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.PROCESSING) {
      response.retry_after = this.pollInterval;
    }

    // 成功的任务添加结果
    if (task.status === TaskStatus.SUCCEEDED && transcript) {
      response.result = {
        segments: transcript.segments || [],
        raw_url: transcript.raw_url,
        srt_url: transcript.srt_url,
        vtt_url: transcript.vtt_url,
      };
    }

    return response;
  }
}
