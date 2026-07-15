import { Module } from '@nestjs/common';
import { AdhesionController } from './adhesion.controller';
import { AdhesionService } from './adhesion.service';

/**
 * Tunnel d'adhésion (Phase 4).
 * PrismaService et TwilioService sont fournis globalement (DatabaseModule /
 * TwilioModule @Global). ThrottlerModule est enregistré dans AppModule.
 */
@Module({
  controllers: [AdhesionController],
  providers: [AdhesionService],
  exports: [AdhesionService],
})
export class AdhesionModule {}
