import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../../providers/supabase/supabase.service';
import { AnonToken, TrialUsage } from '../../database/entities';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private supabaseService: SupabaseService) {}

  /**
   * 生成哈希值
   */
  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * 获取或创建匿名 Token 记录
   */
  async getOrCreateAnonToken(
    anonId: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<AnonToken> {
    const supabase = this.supabaseService.getClient();
    const ipHash = this.hash(ipAddress);
    const uaHash = this.hash(userAgent);

    // 查找现有记录
    const { data: existing } = await supabase
      .from('anon_tokens')
      .select('*')
      .eq('anon_id', anonId)
      .single();

    if (existing) {
      return existing as AnonToken;
    }

    // 创建新记录
    const { data: newToken, error } = await supabase
      .from('anon_tokens')
      .insert({
        anon_id: anonId,
        ip_hash: ipHash,
        ua_hash: uaHash,
        used_trial: false,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create anon token: ${error.message}`);
      throw error;
    }

    return newToken as AnonToken;
  }

  /**
   * 检查是否已使用体验
   */
  async hasUsedTrial(userId: string | null, anonId: string | null): Promise<boolean> {
    const supabase = this.supabaseService.getClient();

    if (userId) {
      // 检查用户是否已使用体验
      const { data } = await supabase
        .from('trial_usages')
        .select('id')
        .eq('user_id', userId)
        .single();
      return !!data;
    }

    if (anonId) {
      // 检查匿名用户是否已使用体验
      const { data } = await supabase
        .from('anon_tokens')
        .select('used_trial')
        .eq('anon_id', anonId)
        .single();
      return data?.used_trial ?? false;
    }

    return false;
  }

  /**
   * 记录体验使用
   */
  async recordTrialUsage(userId: string | null, anonId: string | null): Promise<void> {
    const supabase = this.supabaseService.getClient();

    // 创建体验使用记录
    await supabase.from('trial_usages').insert({
      anon_id: anonId,
      user_id: userId,
      used_at: new Date().toISOString(),
    });

    // 更新 anon_tokens 的 used_trial 标记
    if (anonId) {
      await supabase
        .from('anon_tokens')
        .update({ used_trial: true })
        .eq('anon_id', anonId);
    }
  }

  /**
   * 绑定匿名体验到已登录用户
   */
  async bindTrialToUser(userId: string, anonId: string): Promise<void> {
    const supabase = this.supabaseService.getClient();

    // 更新 trial_usages 中的 user_id
    await supabase
      .from('trial_usages')
      .update({ user_id: userId })
      .eq('anon_id', anonId)
      .is('user_id', null);
  }
}
