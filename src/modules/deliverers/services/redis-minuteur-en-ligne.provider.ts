import { Logger, Provider } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

/** Jeton d'injection de la connexion Redis du minuteur « en ligne » des livreurs. */
export const REDIS_MINUTEUR_EN_LIGNE = Symbol('REDIS_MINUTEUR_EN_LIGNE');

/** Ce que MinuteurEnLigneService utilise de ioredis (remplaçable par un double en test). */
export type ClientRedisMinuteur = Pick<Redis, 'eval' | 'hmget' | 'quit'>;

/**
 * Connexion dédiée, même configuration que le compteur d'appels Google et les
 * plafonds des codes (variables REDIS_*). Le cache (CacheModule) n'offre ni
 * script ni incrément atomique.
 *
 * Une commande échoue tout de suite quand Redis est coupé (pas de file
 * d'attente hors ligne) : le temps de cette coupure n'est pas compté, avec un
 * journal d'erreur, et rien d'autre n'est bloqué.
 */
export const redisMinuteurEnLigneProvider: Provider = {
  provide: REDIS_MINUTEUR_EN_LIGNE,
  useFactory: (): ClientRedisMinuteur => {
    const logger = new Logger('RedisMinuteurEnLigne');
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
    client.on('error', (erreur) => logger.error(`[Redis minuteur en ligne] ${erreur.message}`));
    return client;
  },
};
