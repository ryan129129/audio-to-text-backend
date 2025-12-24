import { Module, DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from './common/config/configuration';

// Providers
import { SupabaseModule } from './providers/supabase/supabase.module';
import { R2Module } from './providers/r2/r2.module';
import { DeepgramModule } from './providers/deepgram/deepgram.module';
import { YouTubeModule } from './providers/youtube/youtube.module';
import { SupadataModule } from './providers/supadata/supadata.module';
import { OpenAIModule } from './providers/openai/openai.module';
import { StripeModule } from './providers/stripe/stripe.module';

// Business Modules
import { AuthModule } from './modules/auth/auth.module';
import { UploadModule } from './modules/upload/upload.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { BillingModule } from './modules/billing/billing.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { TranscriptsModule } from './modules/transcripts/transcripts.module';

// Guards
import { AuthGuard } from './common/guards/auth.guard';

@Module({})
export class AppModule {
  static forRoot(): DynamicModule {
    const imports: any[] = [
      // Config
      ConfigModule.forRoot({
        isGlobal: true,
        load: [configuration],
        envFilePath: ['.env.local', '.env'],
      }),

      // Schedule (定时任务)
      ScheduleModule.forRoot(),

      // Providers
      SupabaseModule,
      R2Module,
      DeepgramModule,
      YouTubeModule,
      SupadataModule,
      OpenAIModule,
      StripeModule,

      // Business Modules
      AuthModule,
      UploadModule,
      TasksModule,
      BillingModule,
      WebhooksModule,
      TranscriptsModule,
    ];

    // 只有当 REDIS_ENABLED=true 时才加载 BullMQ
    if (process.env.REDIS_ENABLED === 'true') {
      imports.push(
        BullModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService) => ({
            connection: {
              url: configService.get<string>('redis.url'),
            },
          }),
          inject: [ConfigService],
        }),
      );
    }

    return {
      module: AppModule,
      imports,
      providers: [
        {
          provide: APP_GUARD,
          useClass: AuthGuard,
        },
      ],
    };
  }
}
