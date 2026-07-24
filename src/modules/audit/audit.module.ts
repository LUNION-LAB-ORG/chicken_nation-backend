import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditCleanupTask } from './audit-cleanup.task';

/**
 * Module d'audit. L'intercepteur est enregistré en GLOBAL via APP_INTERCEPTOR
 * (donc appliqué à toutes les routes, avec injection de dépendances). @Global
 * pour que d'éventuels appels manuels à AuditService restent possibles ailleurs.
 * PrismaService vient du DatabaseModule (déjà @Global).
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditCleanupTask,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
