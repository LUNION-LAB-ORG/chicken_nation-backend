import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis, type RedisOptions } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Adaptateur socket.io basé sur Redis (pub/sub).
 *
 * POURQUOI c'est indispensable ici :
 *   Le backend Chicken Nation tourne en **plusieurs instances** (double backend
 *   pendant la migration + scaling horizontal à terme). Sans adaptateur partagé,
 *   chaque instance ne connaît que les sockets connectés *à elle*. Un
 *   `server.to('customer_X').emit(...)` exécuté sur l'instance A n'atteint donc
 *   PAS un client connecté à l'instance B.
 *
 *   C'est exactement le scénario du suivi de livraison temps réel :
 *     - le livreur (app Deli) peut être connecté à l'instance A
 *     - le client (app cliente) connecté à l'instance B
 *   Quand A relaie la position vers `customer_X`, l'event doit traverser vers B.
 *
 *   L'adaptateur Redis publie chaque émission sur un canal pub/sub Redis que
 *   toutes les instances écoutent → l'event est rejoué sur chaque instance et
 *   délivré au bon socket, où qu'il soit connecté.
 *
 * Réutilise la même config Redis que CacheModule / BullModule (variables
 * REDIS_* du .env). L'auth (username/password) n'est envoyée que si un mot de
 * passe est défini — en local Redis tourne sans auth, en prod avec.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /**
   * Établit les 2 connexions Redis (pub + sub) requises par l'adaptateur.
   * À appeler AVANT `app.listen()` dans `main.ts`.
   *
   * Ne throw pas si Redis est momentanément indisponible : ioredis se reconnecte
   * tout seul en arrière-plan. On loggue les erreurs sans crasher le boot.
   */
  async connectToRedis(): Promise<void> {
    const password = process.env.REDIS_PASSWORD || '';
    const redisOptions: RedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      // Auth conditionnelle : seulement si un mot de passe est configuré.
      ...(password
        ? { username: process.env.REDIS_USERNAME || 'default', password }
        : {}),
      // L'adaptateur émet en continu ; on ne veut pas d'erreurs "max retries".
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    };

    const pubClient = new Redis(redisOptions);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) =>
      this.logger.error(`[Redis pub] ${err.message}`),
    );
    subClient.on('error', (err) =>
      this.logger.error(`[Redis sub] ${err.message}`),
    );
    pubClient.once('ready', () =>
      this.logger.log('socket.io Redis adapter — pub client prêt'),
    );

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('socket.io Redis adapter initialisé (cross-instance ON)');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      this.logger.warn(
        'Redis adapter non initialisé — fallback mémoire (mono-instance). ' +
          'Vérifie que connectToRedis() est bien appelé avant app.listen().',
      );
    }
    return server;
  }
}
