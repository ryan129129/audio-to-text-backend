import { Controller, Get, Post, Body, Param, Query, SetMetadata } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentUser as ICurrentUser } from '../../common/interfaces/response.interface';
import { ALLOW_ANONYMOUS_KEY } from '../../common/guards/auth.guard';
import { CreateTaskDto, CreateTaskResponseDto } from './dto/create-task.dto';
import { TaskResponseDto, TaskListResponseDto, GetTasksQueryDto } from './dto/task.dto';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /**
   * POST /api/tasks
   * 创建任务
   */
  @Post()
  @SetMetadata(ALLOW_ANONYMOUS_KEY, true)
  async createTask(
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: ICurrentUser,
  ): Promise<CreateTaskResponseDto> {
    return this.tasksService.createTask(dto, user);
  }

  /**
   * GET /api/tasks/:id
   * 获取任务详情
   */
  @Get(':id')
  @SetMetadata(ALLOW_ANONYMOUS_KEY, true)
  async getTask(
    @Param('id') id: string,
    @CurrentUser() user: ICurrentUser,
  ): Promise<TaskResponseDto> {
    return this.tasksService.getTask(id, user);
  }

  /**
   * GET /api/tasks
   * 获取任务列表
   */
  @Get()
  @SetMetadata(ALLOW_ANONYMOUS_KEY, true)
  async getTasks(
    @Query() query: GetTasksQueryDto,
    @CurrentUser() user: ICurrentUser,
  ): Promise<TaskListResponseDto> {
    return this.tasksService.getTasks(query, user);
  }
}
