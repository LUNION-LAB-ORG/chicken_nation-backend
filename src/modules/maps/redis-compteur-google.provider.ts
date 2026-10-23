import { Logger, Provider } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

/** Jeton d'injection de la connexion Redis du compteur d'appels Google. */
export const REDIS_COMPTEUR_GOOGLE = Symbol('REDIS_COMPTEUR_GOOGLE');

/** Ce que CompteurAppelsGoogleService utilise de ioredis (remplaçable par un double en test). */
export type ClientRedisCompteur = Pick<Redis, 'multi' | 'mget' | 'quit'>;

/**
 * Connexion dédiée, même configuration que BullModule, l'adaptateur
 * socket.io et les plafonds des codes (variables REDIS_*). Le cache
 * (CacheModule) n'offre pas d'incrément atomique.
 *
 * Une commande échoue tout de suite quand Redis est coupé (pas de file
 * d'attente hors ligne) : Google reste alors utilisé sans compteur, avec un
 * journal d'erreur, plutôt que de couper les cartes faute de compteur.
 */
export const redisCompteurGoogleProvider: Provider = {
  provide: REDIS_COMPTEUR_GOOGLE,
  useFactory: (): ClientRedisCompteur => {
    const logger = new Logger('RedisCompteurGoogle');
    const password = process.env.REDIS_PASSWORD || '';
    const options: RedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      ...(password ? { username: process.env.REDIS_USERNAME || 'default', password } : {}),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (essais) => Math.min(essais * 200, 5000),
    };
    const client = new Redis(options);
    client.on('error', (erreur) => logger.error(`[Redis compteur Google] ${erreur.message}`));
    return client;
  },
};
