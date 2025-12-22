import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from '../interfaces/response.interface';

/**
 * 统一响应拦截器
 * 将所有成功响应包装为 { data: T, error: null } 格式
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // 如果返回值已经是 ApiResponse 格式，直接返回
        if (data && typeof data === 'object' && 'data' in data && 'error' in data) {
          return data;
        }
        // 否则包装成统一格式
        return {
          data,
          error: null,
        };
      }),
    );
  }
}
