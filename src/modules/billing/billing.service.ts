import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { Balance } from '../../database/entities';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private supabaseService: SupabaseService) {}

  /**
   * 获取用户余额
   */
  async getBalance(userId: string): Promise<Balance | null> {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('balances')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as Balance;
  }

  /**
   * 检查余额是否足够
   */
  async hasEnoughBalance(userId: string, requiredMinutes: number): Promise<boolean> {
    const balance = await this.getBalance(userId);
    if (!balance) return false;
    return balance.minutes_balance >= requiredMinutes;
  }

  /**
   * 扣减余额（使用原子更新防止并发问题）
   */
  async deductBalance(userId: string, minutes: number): Promise<boolean> {
    const supabase = this.supabaseService.getClient();

    // 1. 先获取当前余额
    const currentBalance = await this.getBalance(userId);
    if (!currentBalance) {
      this.logger.error(`Balance not found for user ${userId}`);
      return false;
    }

    // 2. 检查余额是否足够
    if (currentBalance.minutes_balance < minutes) {
      this.logger.error(`Insufficient balance for user ${userId}: ${currentBalance.minutes_balance} < ${minutes}`);
      return false;
    }

    // 3. 使用条件更新实现乐观锁
    // 只有当 minutes_balance >= minutes 时才更新
    const newBalance = currentBalance.minutes_balance - minutes;
    const { data, error } = await supabase
      .from('balances')
      .update({
        minutes_balance: newBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .gte('minutes_balance', minutes) // 乐观锁条件
      .select()
      .single();

    if (error || !data) {
      this.logger.error(`Failed to deduct balance: ${error?.message || 'No rows updated'}`);
      return false;
    }

    this.logger.log(`Deducted ${minutes} minutes from user ${userId}, new balance: ${newBalance}`);
    return true;
  }

  /**
   * 增加余额
   */
  async addBalance(userId: string, minutes: number): Promise<boolean> {
    const supabase = this.supabaseService.getClient();

    // 先检查是否存在余额记录
    const currentBalance = await this.getBalance(userId);

    if (currentBalance) {
      // 更新现有余额
      const newBalance = currentBalance.minutes_balance + minutes;
      const { error } = await supabase
        .from('balances')
        .update({
          minutes_balance: newBalance,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to add balance: ${error.message}`);
        return false;
      }

      this.logger.log(`Added ${minutes} minutes to user ${userId}, new balance: ${newBalance}`);
    } else {
      // 创建新余额记录
      const { error } = await supabase
        .from('balances')
        .insert({
          user_id: userId,
          minutes_balance: minutes,
          updated_at: new Date().toISOString(),
        });

      if (error) {
        this.logger.error(`Failed to create balance: ${error.message}`);
        return false;
      }

      this.logger.log(`Created balance for user ${userId} with ${minutes} minutes`);
    }

    return true;
  }

  /**
   * 获取体验状态
   */
  async getTrialStatus(userId: string | null, anonId: string | null): Promise<{
    hasUsedTrial: boolean;
    remainingMinutes: number;
  }> {
    const supabase = this.supabaseService.getClient();
    let hasUsedTrial = false;

    if (userId) {
      const { data } = await supabase
        .from('trial_usages')
        .select('id')
        .eq('user_id', userId)
        .single();
      hasUsedTrial = !!data;
    } else if (anonId) {
      const { data } = await supabase
        .from('anon_tokens')
        .select('used_trial')
        .eq('anon_id', anonId)
        .single();
      hasUsedTrial = data?.used_trial ?? false;
    }

    return {
      hasUsedTrial,
      remainingMinutes: hasUsedTrial ? 0 : 30,
    };
  }
}
