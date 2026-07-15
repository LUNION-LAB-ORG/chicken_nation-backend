import { Module } from '@nestjs/common';
import { AdhesionController } from './adhesion.controller';
import { AdhesionService } from './adhesion.service';
import { CardNationModule } from 'src/modules/card-nation/card-nation.module';

/**
 * Tunnel d'adhésion (Phase 4).
 * PrismaService et TwilioService sont fournis globalement (DatabaseModule /
 * TwilioModule @Global). ThrottlerModule est enregistré dans AppModule.
 */
@Module({
  imports: [CardNationModule], // réutilise CardRequestService pour émettre la carte à l'adhésion
  controllers: [AdhesionController],
  providers: [AdhesionService],
  exports: [AdhesionService],
})
export class AdhesionModule {}
