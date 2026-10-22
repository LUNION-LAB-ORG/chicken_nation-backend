import { Global, Module } from '@nestjs/common';

import { DispatchJournalService } from './services/dispatch-journal.service';
import { OffresClotureService } from './services/offres-cloture.service';

/**
 * Journal de la diffusion et clôture des offres, partagés par les modules
 * course, livreurs et authentification des livreurs.
 *
 * Global, et sans dépendance autre que la base et le bus d'événements (tous
 * deux globaux) : le module des livreurs (pause, déconnexion) et celui de
 * l'authentification les utilisent sans importer le module course, qui
 * importe déjà ces deux modules.
 */
@Global()
@Module({
  providers: [DispatchJournalService, OffresClotureService],
  exports: [DispatchJournalService, OffresClotureService],
})
export class DispatchCommunModule {}
