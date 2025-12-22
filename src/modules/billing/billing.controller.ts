import { Controller, Get, SetMetadata } from '@nestjs/common';
import { BillingService } from './billing.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentUser as ICurrentUser } from '../../common/interfaces/response.interface';
import { ALLOW_ANONYMOUS_KEY } from '../../common/guards/auth.guard';

export interface BalanceResponseDto {
  minutes_balance: number;
  trial_available: boolean;
  trial_remaining_minutes: number;
}

@Controller('balance')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * GET /api/balance
   * 获取当前用户余额和体验状态
   */
  @Get()
  @SetMetadata(ALLOW_ANONYMOUS_KEY, true)
  async getBalance(@CurrentUser() user: ICurrentUser): Promise<BalanceResponseDto> {
    let minutesBalance = 0;

    if (user.id) {
      const balance = await this.billingService.getBalance(user.id);
      minutesBalance = balance?.minutes_balance ?? 0;
    }

    const trialStatus = await this.billingService.getTrialStatus(
      user.id,
      user.anonId,
    );

    return {
      minutes_balance: minutesBalance,
      trial_available: !trialStatus.hasUsedTrial,
      trial_remaining_minutes: trialStatus.remainingMinutes,
    };
  }
}
