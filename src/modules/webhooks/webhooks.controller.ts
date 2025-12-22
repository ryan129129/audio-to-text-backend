import {
  Controller,
  Post,
  Body,
  Headers,
  RawBodyRequest,
  Req,
  SetMetadata,
  HttpCode,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DeepgramWebhookService } from './deepgram.service';
import { StripeWebhookService } from './stripe.service';
import { IS_PUBLIC_KEY } from '../../common/guards/auth.guard';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly deepgramWebhookService: DeepgramWebhookService,
    private readonly stripeWebhookService: StripeWebhookService,
  ) {}

  /**
   * POST /api/webhooks/deepgram
   * Deepgram 回调
   */
  @Post('deepgram')
  @SetMetadata(IS_PUBLIC_KEY, true)
  @HttpCode(200)
  async handleDeepgramWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Body() body: any,
    @Headers('dg-signature') signature: string,
  ): Promise<{ received: boolean }> {
    const rawBody = req.rawBody?.toString();
    await this.deepgramWebhookService.handleWebhook(body, signature, rawBody);
    return { received: true };
  }

  /**
   * POST /api/webhooks/stripe
   * Stripe 回调
   */
  @Post('stripe')
  @SetMetadata(IS_PUBLIC_KEY, true)
  @HttpCode(200)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new Error('Raw body not available');
    }
    await this.stripeWebhookService.handleWebhook(rawBody, signature);
    return { received: true };
  }
}
