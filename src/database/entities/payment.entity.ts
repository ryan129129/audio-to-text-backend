/**
 * 支付事件类型
 */
export enum PaymentEventType {
  INVOICE_PAID = 'invoice.paid',
  SUBSCRIPTION_CREATED = 'subscription.created',
  SUBSCRIPTION_UPDATED = 'subscription.updated',
  SUBSCRIPTION_CANCELED = 'subscription.canceled',
  PAYMENT_FAILED = 'payment_failed',
}

/**
 * 支付记录实体（对应 payments 表）
 */
export interface Payment {
  id: string; // PK
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  event_type: PaymentEventType;
  minutes_delta: number; // 分钟变动（正数增加，负数减少）
  raw_event: Record<string, any>; // Stripe 原始事件
  created_at: string;
}
