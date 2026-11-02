import { Module } from '@nestjs/common';
import { CustomerService } from './services/customer.service';
import { CustomerController } from './controllers/customer.controller';
import { AddressController } from './controllers/address.controller';
import { FavoriteController } from './controllers/favorite.controller';
import { AddressService } from './services/address.service';
import { FavoriteService } from './services/favorite.service';
import { CommentController } from './controllers/comment.controller';
import { CommentService } from './services/comment.service';
import { CustomerEvent } from './events/customer.event';
import { NotificationSettingService } from './services/notification-setting.service';
import { CustomerCleanupTask } from './tasks/customer-cleanup.task';
import { CustomerListenerService } from './listeners/customer-listener.service';
import { CustomerNotificationsTemplate } from './templates/customer-notifications.template';
import { SupportModule } from '../support/support.module';
import { AvisPriveController } from './avis-prives/avis-prive.controller';
import { AvisPriveService } from './avis-prives/avis-prive.service';
import { AvisPriveDepotService } from './avis-prives/avis-prive-depot.service';
import { AvisPriveTraitementService } from './avis-prives/avis-prive-traitement.service';
import { AvisPriveLimitesService, redisAvisPrivesProvider } from './avis-prives/avis-prive-limites.service';
import { AvisPriveRetardTask } from './avis-prives/avis-prive-retard.task';

@Module({
  // Retours privés « Ton avis compte » : « Créer un incident » ouvre un ticket
  // du module Messages et tickets (TicketService).
  imports: [SupportModule],
  controllers: [
    CustomerController,
    AddressController,
    FavoriteController,
    CommentController,
    AvisPriveController,
  ],
  providers: [
    CustomerService,
    AddressService,
    FavoriteService,
    CommentService,
    CustomerEvent,
    NotificationSettingService,
    CustomerCleanupTask,
    CustomerListenerService,
    CustomerNotificationsTemplate,
    AvisPriveService,
    AvisPriveDepotService,
    AvisPriveTraitementService,
    AvisPriveLimitesService,
    redisAvisPrivesProvider,
    AvisPriveRetardTask,
  ],
})
export class CustomerModule { }
