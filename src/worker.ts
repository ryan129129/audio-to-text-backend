import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Worker 入口
 * 独立进程运行，消费 BullMQ 队列任务
 */
async function bootstrap() {
  const logger = new Logger('Worker');

  // 创建应用上下文（不启动 HTTP 服务）
  const app = await NestFactory.createApplicationContext(AppModule);

  logger.log('Worker started and listening for jobs...');

  // 优雅关闭
  process.on('SIGTERM', async () => {
    logger.log('Received SIGTERM, shutting down...');
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.log('Received SIGINT, shutting down...');
    await app.close();
    process.exit(0);
  });
}

bootstrap();
