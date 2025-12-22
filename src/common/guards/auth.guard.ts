import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CurrentUser } from '../interfaces/response.interface';

export const IS_PUBLIC_KEY = 'isPublic';
export const ALLOW_ANONYMOUS_KEY = 'allowAnonymous';

/**
 * 认证守卫
 * 支持 Supabase JWT 和匿名 token（X-Anon-Id）
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private supabase: SupabaseClient;

  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
  ) {
    this.supabase = createClient(
      this.configService.get<string>('supabase.url')!,
      this.configService.get<string>('supabase.serviceRoleKey')!,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 检查是否为公开路由
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // 检查是否允许匿名访问
    const allowAnonymous = this.reflector.getAllAndOverride<boolean>(
      ALLOW_ANONYMOUS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    const anonId = request.headers['x-anon-id'] as string | undefined;

    const currentUser: CurrentUser = {
      id: null,
      anonId: anonId || null,
      isAuthenticated: false,
    };

    // 尝试验证 JWT
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const { data: { user }, error } = await this.supabase.auth.getUser(token);
        if (!error && user) {
          currentUser.id = user.id;
          currentUser.isAuthenticated = true;
        }
      } catch (err) {
        this.logger.warn(`JWT validation failed: ${err}`);
      }
    }

    // 设置用户信息到请求对象
    request.user = currentUser;

    // 如果允许匿名访问，只需要有 anonId 即可
    if (allowAnonymous) {
      if (currentUser.isAuthenticated || currentUser.anonId) {
        return true;
      }
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication or anonymous token required',
      });
    }

    // 否则必须已认证
    if (!currentUser.isAuthenticated) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    return true;
  }
}
