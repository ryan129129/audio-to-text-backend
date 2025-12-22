import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { StripeService } from '../../providers/stripe/stripe.service';
import { BillingService } from '../billing/billing.service';
import { PaymentEventType } from '../../database/entities';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private supabaseService: SupabaseService,
    private stripeService: StripeService,
    private billingService: BillingService,
  ) {}

  /**
   * 处理 Stripe Webhook
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = this.stripeService.constructEvent(rawBody.toString(), signature);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err}`);
      throw new BadRequestException('Invalid signature');
    }

    // 幂等检查
    const eventId = event.id;
    const supabase = this.supabaseService.getClient();

    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('id', eventId)
      .single();

    if (existing) {
      this.logger.log(`Event ${eventId} already processed, skipping`);
      return;
    }

    this.logger.log(`Processing Stripe event: ${event.type}`);

    switch (event.type) {
      case 'invoice.paid':
        await this.handleInvoicePaid(event);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdate(event);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionCanceled(event);
        break;
      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }
  }

  private async handleInvoicePaid(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    const customerId = invoice.customer as string;
    const subscriptionId = (invoice as any).subscription as string || null;

    // 获取用户 ID
    const userId = await this.getUserIdByCustomerId(customerId);
    if (!userId) {
      this.logger.warn(`No user found for customer ${customerId}`);
      return;
    }

    // 计算增加的分钟数（根据订阅计划）
    // 这里简化处理，实际应根据 line_items 计算
    const minutesDelta = this.calculateMinutesFromInvoice(invoice);

    // 增加余额
    await this.billingService.addBalance(userId, minutesDelta);

    // 记录支付事件
    await this.recordPayment({
      id: event.id,
      userId,
      customerId,
      subscriptionId,
      eventType: PaymentEventType.INVOICE_PAID,
      minutesDelta,
      rawEvent: event,
    });

    this.logger.log(`Added ${minutesDelta} minutes to user ${userId}`);
  }

  private async handleSubscriptionUpdate(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    const userId = await this.getUserIdByCustomerId(customerId);
    if (!userId) {
      this.logger.warn(`No user found for customer ${customerId}`);
      return;
    }

    await this.recordPayment({
      id: event.id,
      userId,
      customerId,
      subscriptionId: subscription.id,
      eventType: PaymentEventType.SUBSCRIPTION_UPDATED,
      minutesDelta: 0,
      rawEvent: event,
    });
  }

  private async handleSubscriptionCanceled(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;

    const userId = await this.getUserIdByCustomerId(customerId);
    if (!userId) {
      this.logger.warn(`No user found for customer ${customerId}`);
      return;
    }

    await this.recordPayment({
      id: event.id,
      userId,
      customerId,
      subscriptionId: subscription.id,
      eventType: PaymentEventType.SUBSCRIPTION_CANCELED,
      minutesDelta: 0,
      rawEvent: event,
    });

    this.logger.log(`Subscription canceled for user ${userId}`);
  }

  private async getUserIdByCustomerId(customerId: string): Promise<string | null> {
    const supabase = this.supabaseService.getClient();

    const { data } = await supabase
      .from('payments')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .limit(1)
      .single();

    return data?.user_id || null;
  }

  private calculateMinutesFromInvoice(invoice: Stripe.Invoice): number {
    // 根据实际订阅计划计算
    // 这里简化返回固定值，实际应根据 price_id 配置
    const amountPaid = (invoice.amount_paid || 0) / 100; // 转换为美元
    // 假设 $10 = 100 分钟
    return Math.floor(amountPaid * 10);
  }

  private async recordPayment(payment: {
    id: string;
    userId: string;
    customerId: string;
    subscriptionId: string | null;
    eventType: PaymentEventType;
    minutesDelta: number;
    rawEvent: Stripe.Event;
  }): Promise<void> {
    const supabase = this.supabaseService.getClient();

    await supabase.from('payments').insert({
      id: payment.id,
      user_id: payment.userId,
      stripe_customer_id: payment.customerId,
      stripe_subscription_id: payment.subscriptionId,
      event_type: payment.eventType,
      minutes_delta: payment.minutesDelta,
      raw_event: payment.rawEvent,
      created_at: new Date().toISOString(),
    });
  }
}
