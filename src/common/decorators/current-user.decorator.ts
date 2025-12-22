import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CurrentUser as ICurrentUser } from '../interfaces/response.interface';

/**
 * 获取当前用户装饰器
 * 从请求对象中提取用户信息
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): ICurrentUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user || {
      id: null,
      anonId: null,
      isAuthenticated: false,
    };
  },
);
