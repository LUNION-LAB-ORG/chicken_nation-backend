import { Logger, Provider } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

import { JournalLimite, suffixeTues } from 'src/common/utils/journal-limite.util';

/** Jeton d'injection de la connexion Redis des fins de socket des livreurs. */
export const REDIS_FINS_SOCKET = Symbol('REDIS_FINS_SOCKET');

/**
 * Connexion dédiée, même configuration que le minuteur « en ligne » des
 * livreurs (variables REDIS_*). Une commande échoue tout de suite quand Redis
 * est coupé (pas de file d'attente hors ligne, un seul essai) : aucune preuve
 * de fermeture, rien d'autre n'est bloqué.
 */
export const redisFinsSocketProvider: Provider = {
  provide: REDIS_FINS_SOCKET,
  useFactory: (): Redis => {
    const logger = new Logger('RedisFinsSocket');
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
    // Redis coupé : une ligne par minute au plus (les reconnexions se suivent toutes les 5 s).
    const limite = new JournalLimite(60_000);
    client.on('error', (erreur) => {
      const tues = limite.autoriser('erreur');
      if (tues !== null) logger.error(`[Redis fins de socket] ${erreur.message}${suffixeTues(tues)}`);
    });
    return client;
  },
};
