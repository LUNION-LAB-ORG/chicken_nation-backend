import { Module } from '@nestjs/common';
import { ProspectController } from './controllers/prospect.controller';
import { ProspectService } from './services/prospect.service';

/**
 * Module « Base de Données » — captation & conversion des clients Glovo/Yango.
 * (PrismaService est fourni globalement par DatabaseModule.)
 */
@Module({
  controllers: [ProspectController],
  providers: [ProspectService],
  exports: [ProspectService],
})
export class ProspectModule {}
