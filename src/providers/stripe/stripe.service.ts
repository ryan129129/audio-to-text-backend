import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;
  private webhookSecret: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const secretKey = this.configService.get<string>('stripe.secretKey');
    this.webhookSecret = this.configService.get<string>('stripe.webhookSecret') || '';

    if (!secretKey) {
      this.logger.warn('Stripe secret key not configured');
      return;
    }

    this.stripe = new Stripe(secretKey);

    this.logger.log('Stripe service initialized');
  }

  getClient(): Stripe {
    return this.stripe;
  }

  /**
   * 验证 Webhook 签名
   */
  constructEvent(payload: string | Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  /**
   * 获取客户信息
   */
  async getCustomer(customerId: string): Promise<Stripe.Customer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      if (customer.deleted) return null;
      return customer as Stripe.Customer;
    } catch {
      return null;
    }
  }

  /**
   * 获取订阅信息
   */
  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
    try {
      return await this.stripe.subscriptions.retrieve(subscriptionId);
    } catch {
      return null;
    }
  }

  /**
   * 创建 Checkout Session
   */
  async createCheckoutSession(
    customerId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
  }

  /**
   * 创建客户门户 Session
   */
  async createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }
}
