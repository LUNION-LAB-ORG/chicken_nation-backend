import { Module } from '@nestjs/common';
import { FidelityModule } from '../fidelity/fidelity.module';
import { ComboController } from './controllers/combo.controller';
import { ComboAdminController } from './controllers/combo-admin.controller';
import { ComboService } from './services/combo.service';
import { ComboAdminService } from './services/combo-admin.service';
import { ComboTask } from './tasks/combo.task';

/**
 * COMBO MYSTÈRE (Phase 6). Jeu-concours : combinaison secrète d'items du menu,
 * essais bornés (RG-10), tirage au sort de N gagnants à la clôture, récompense
 * via le système Reward (GIFT). Réutilise `RewardService` (exporté par FidelityModule).
 */
@Module({
  imports: [FidelityModule],
  controllers: [ComboController, ComboAdminController],
  providers: [ComboService, ComboAdminService, ComboTask],
  exports: [ComboService],
})
export class ComboModule {}
