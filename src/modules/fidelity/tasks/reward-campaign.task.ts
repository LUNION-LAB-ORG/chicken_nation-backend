import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { RewardCampaignService } from '../services/reward-campaign.service';

/**
 * CRON — distribue les campagnes « Envoyer un cadeau » PROGRAMMÉES arrivées à
 * échéance. Tourne chaque minute.
 *
 * Double backend : claim ATOMIQUE (updateMany conditionné `status:'scheduled'`
 * → `'sending'`) avant dispatch → une seule instance distribue une campagne
 * donnée. Poser `DISABLE_REWARD_CRON=true` sur les instances non-worker.
 */
@Injectable()
export class RewardCampaignTask {
  private readonly logger = new Logger(RewardCampaignTask.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rewardCampaignService: RewardCampaignService,
  ) {}

  @Cron('* * * * *')
  async processScheduledCampaigns() {
    if (process.env.DISABLE_REWARD_CRON === 'true') return;
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();
      const due = await this.prisma.rewardCampaign.findMany({
        where: { status: 'scheduled', scheduled_at: { lte: now } },
      });
      if (due.length === 0) return;

      for (const campaign of due) {
        // Claim atomique : seul le tick/instance qui bascule scheduled→sending distribue.
        const claim = await this.prisma.rewardCampaign.updateMany({
          where: { id: campaign.id, status: 'scheduled' },
          data: { status: 'sending', updated_at: new Date() },
        });
        if (claim.count === 0) continue;

        try {
          await this.rewardCampaignService.dispatch({ ...campaign, status: 'sending' });
        } catch (error) {
          this.logger.error(
            `Échec distribution campagne ${campaign.id}: ${(error as Error)?.message}`,
          );
          await this.prisma.rewardCampaign.update({
            where: { id: campaign.id },
            data: { status: 'failed', updated_at: new Date() },
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
