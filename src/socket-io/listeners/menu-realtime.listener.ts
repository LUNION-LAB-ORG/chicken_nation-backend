import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppGateway } from '../gateways/app.gateway';

type MenuEntity = 'dish' | 'category' | 'supplement';
type MenuAction = 'created' | 'updated' | 'deleted';

/**
 * Pont temps réel MENU → clients.
 *
 * Écoute les événements internes EventEmitter2 émis par le module menu
 * (dish/category/supplement × created/updated/deleted) et diffuse un unique
 * event WebSocket `menu:updated` à la room `customers`. L'app cliente s'en
 * sert pour invalider instantanément son cache menu (plats/catégories) après
 * une modification backoffice, au lieu de garder des données obsolètes.
 *
 * Provider du module socket-io : il a déjà accès à AppGateway (même module),
 * et écoute via `@OnEvent`, donc AUCUNE dépendance circulaire avec le module
 * menu (couplage lâche via l'event bus).
 *
 * Best-effort : toute erreur d'émission est avalée pour ne JAMAIS casser le
 * flux métier (création/màj/suppression du menu).
 */
@Injectable()
export class MenuRealtimeListener {
  private readonly logger = new Logger(MenuRealtimeListener.name);

  constructor(private readonly appGateway: AppGateway) { }

  private emit(entity: MenuEntity, action: MenuAction, id?: string) {
    try {
      this.appGateway.emitToUserType('customers', 'menu:updated', {
        entity,
        action,
        id,
      });
    } catch (error) {
      // Best-effort : ne jamais interrompre l'opération menu à cause du WS.
      this.logger.debug(
        `Emission menu:updated échouée (${entity}/${action}): ${(error as Error)?.message}`,
      );
    }
  }

  // ================================
  // PLATS
  // ================================

  @OnEvent('dish.created')
  onDishCreated(payload: { dish?: { id?: string } }) {
    this.emit('dish', 'created', payload?.dish?.id);
  }

  @OnEvent('dish.updated')
  onDishUpdated(payload: { id?: string }) {
    this.emit('dish', 'updated', payload?.id);
  }

  @OnEvent('dish.deleted')
  onDishDeleted(payload: { id?: string }) {
    this.emit('dish', 'deleted', payload?.id);
  }

  // ================================
  // CATÉGORIES
  // ================================

  @OnEvent('category.created')
  onCategoryCreated(payload: { category?: { id?: string } }) {
    this.emit('category', 'created', payload?.category?.id);
  }

  @OnEvent('category.updated')
  onCategoryUpdated(payload: { id?: string }) {
    this.emit('category', 'updated', payload?.id);
  }

  @OnEvent('category.deleted')
  onCategoryDeleted(payload: { id?: string }) {
    this.emit('category', 'deleted', payload?.id);
  }

  // ================================
  // SUPPLÉMENTS
  // ================================

  @OnEvent('supplement.created')
  onSupplementCreated(payload: { id?: string }) {
    this.emit('supplement', 'created', payload?.id);
  }

  @OnEvent('supplement.updated')
  onSupplementUpdated(payload: { id?: string }) {
    this.emit('supplement', 'updated', payload?.id);
  }

  @OnEvent('supplement.deleted')
  onSupplementDeleted(payload: { id?: string }) {
    this.emit('supplement', 'deleted', payload?.id);
  }
}
