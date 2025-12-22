import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { DeepgramWebhookService } from './deepgram.service';
import { StripeWebhookService } from './stripe.service';
import { TasksModule } from '../tasks/tasks.module';
import { BillingModule } from '../billing/billing.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TasksModule, BillingModule, TranscriptsModule, AuthModule],
  controllers: [WebhooksController],
  providers: [DeepgramWebhookService, StripeWebhookService],
})
export class WebhooksModule {}
