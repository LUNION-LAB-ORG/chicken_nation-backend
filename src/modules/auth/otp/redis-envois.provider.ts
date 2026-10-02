import { Logger, Provider } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

/** Jeton d'injection de la connexion Redis des plafonds d'envoi de codes. */
export const REDIS_ENVOIS_OTP = Symbol('REDIS_ENVOIS_OTP');

/** Ce qu'EnvoisOtpService utilise de ioredis (remplaçable par un double en test). */
export type ClientRedisEnvois = Pick<Redis, 'set' | 'pttl' | 'del' | 'multi' | 'quit'>;

/**
 * Connexion dédiée, avec la même configuration Redis que BullModule et
 * l'adaptateur socket.io (variables REDIS_*). Le cache (CacheModule) ne suffit
 * pas : il n'offre ni incrément atomique ni « poser si absent ».
 *
 * Une commande échoue tout de suite quand Redis est coupé, au lieu d'attendre
 * la reconnexion : l'envoi du code continue alors sans les plafonds (la
 * connexion des clients passe avant), avec un journal d'erreur.
 */
export const redisEnvoisOtpProvider: Provider = {
  provide: REDIS_ENVOIS_OTP,
  useFactory: (): ClientRedisEnvois => {
    const logger = new Logger('RedisEnvoisOtp');
    const password = process.env.REDIS_PASSWORD || '';
    const options: RedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      // Authentification seulement si un mot de passe est configuré (comme
      // l'adaptateur socket.io : Redis sans mot de passe en local).
      ...(password ? { username: process.env.REDIS_USERNAME || 'default', password } : {}),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (essais) => Math.min(essais * 200, 5000),
    };
    const client = new Redis(options);
    client.on('error', (erreur) => logger.error(`[Redis plafonds des codes] ${erreur.message}`));
    return client;
  },
};
