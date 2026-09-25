import { urlApiDepuis } from '../../common/utils/url-publique.util';
/**
 * Service d'authentification OAuth 2.0 HubRise.
 *
 * Flux OAuth :
 * 1. Un ADMIN authentifié demande l'URL d'autorisation (POST connect) : le
 *    `state` y est signé (restaurant, utilisateur, expiration, nonce)
 * 2. HubRise redirige vers notre callback avec un `code` d'autorisation
 * 3. Le `state` est vérifié AVANT tout échange, puis le `code` est échangé
 *    contre un `access_token`
 * 4. Le token est stocké en base (Restaurant.hubrise_access_token), sans
 *    jamais écraser une autre liaison
 *
 * Documentation : https://developers.hubrise.com/api/authentication
 *
 * ⚠️ Scopes disponibles (format HubRise) :
 * location[resource.access_right, ...] — permissions à l'intérieur des crochets
 * Exemple : location[orders.write,customer_list.write,catalog.read]
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { estUuid } from 'src/common/utils/identifiant.util';
import { HUBRISE_OAUTH } from '../constants/hubrise-endpoints.constant';
import {
  DUREE_ETAT_SECONDES,
  cleCacheNonce,
  cleEtatDepuis,
  nouveauNonce,
  signerEtat,
  valeurNonce,
  verifierEtat,
} from '../utils/etat-oauth.util';
import { MotifRetour, peutConnecterHubrise } from '../utils/retour-oauth.util';

// Scopes demandés — format HubRise : location[resource.access, ...]
// write inclut read — une seule permission par resource type
const HUBRISE_SCOPES =
  'location[orders.write,customer_list.write,catalog.read]';

// Un code d'autorisation HubRise fait une trentaine de caractères.
const LONGUEUR_MAX_CODE = 512;

// Réponse du token OAuth HubRise
interface HubriseTokenResponse {
  access_token: string;
  /** ID du compte HubRise */
  account_id?: string;
  /** Nom du compte HubRise */
  account_name?: string;
  /** ID du location HubRise connecté */
  location_id?: string;
  /** Nom du location */
  location_name?: string;
  /** ID de la liste de clients */
  customer_list_id?: string;
  /** ID du catalogue */
  catalog_id?: string;
}

/** Issue du retour OAuth : le jeton à inscrire au webhook, ou un motif d'échec. */
export type ResultatRetourHubrise =
  | { ok: true; accessToken: string }
  | { ok: false; motif: MotifRetour };

@Injectable()
export class HubriseAuthService {
  private readonly logger = new Logger(HubriseAuthService.name);
  private cleEtatMemo: Buffer | null = null;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Clé de signature du `state` : `HUBRISE_STATE_SECRET` (32 caractères au
   * moins), sinon dérivée de `TOKEN_SECRET`. Jamais la table Settings ni le
   * `client_secret` HubRise : une clé que HubRise connaît ne peut pas
   * authentifier ce que HubRise nous renvoie.
   */
  private cleEtat(): Buffer {
    if (this.cleEtatMemo) return this.cleEtatMemo;

    const { cle, source, dedieeIgnoree } = cleEtatDepuis(
      this.config.get<string>('HUBRISE_STATE_SECRET'),
      this.config.get<string>('TOKEN_SECRET'),
    );
    if (dedieeIgnoree) {
      this.logger.warn(
        '[HubRise OAuth] HUBRISE_STATE_SECRET fait moins de 32 caractères : ignorée, clé dérivée de TOKEN_SECRET.',
      );
    } else if (source === 'derivee') {
      this.logger.log('[HubRise OAuth] HUBRISE_STATE_SECRET absente : clé dérivée de TOKEN_SECRET.');
    }

    this.cleEtatMemo = cle;
    return cle;
  }

  /**
   * Prépare la connexion d'un restaurant : signe le `state` (restaurant,
   * utilisateur, expiration, nonce), pose le nonce en cache et renvoie l'URL
   * d'autorisation HubRise que le backoffice ouvre.
   *
   * @param restaurantId - ID du restaurant CN
   * @param userId - utilisateur authentifié qui demande la connexion
   * @returns URL complète d'autorisation HubRise
   */
  async getAuthorizationUrl(restaurantId: string, userId: string): Promise<string> {
    if (!estUuid(restaurantId)) {
      throw new BadRequestException('Identifiant de restaurant invalide');
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
    });
    if (!restaurant) {
      throw new NotFoundException('Restaurant introuvable');
    }

    const config = await this.settingsService.getManyOrEnv({
      hubrise_client_id: 'HUBRISE_CLIENT_ID',
      base_url: 'BASE_URL',
    });

    const clientId = config.hubrise_client_id;
    const baseUrl = config.base_url || '';
    // `base_url` peut déjà porter le préfixe : on ne le rajoute pas deux fois.
    const redirectUri = urlApiDepuis(baseUrl, 'hubrise/auth/callback');

    if (!clientId) {
      this.logger.error('[HubRise OAuth] HUBRISE_CLIENT_ID non configuré.');
      throw new ServiceUnavailableException(
        "La connexion HubRise n'est pas configurée sur le serveur.",
      );
    }

    let cleSignature: Buffer;
    try {
      cleSignature = this.cleEtat();
    } catch (error) {
      this.logger.error(`[HubRise OAuth] ${error}`);
      throw new ServiceUnavailableException(
        "La connexion HubRise n'est pas configurée sur le serveur.",
      );
    }

    const nonce = nouveauNonce();
    const state = signerEtat(
      { restaurantId: restaurant.id, userId, maintenant: Date.now(), nonce },
      cleSignature,
    );

    // Nonce à usage unique, consommé au retour. On relit la clé juste après
    // l'avoir écrite : le magasin Redis avale ses erreurs, et un nonce absent
    // enverrait l'ADMIN vers un retour voué au refus.
    const cle = cleCacheNonce(nonce);
    const valeur = valeurNonce(restaurant.id, userId);
    let relu: string | undefined;
    try {
      await this.cache.set(cle, valeur, DUREE_ETAT_SECONDES * 1000);
      relu = await this.cache.get<string>(cle);
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Cache indisponible : ${error}`);
    }
    if (relu !== valeur) {
      throw new ServiceUnavailableException(
        'Impossible de préparer la connexion HubRise. Réessayez.',
      );
    }

    // Construction manuelle de l'URL pour éviter l'encodage des crochets []
    // URLSearchParams encode [] en %5B%5D, ce que HubRise n'accepte pas
    const params = [
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `client_id=${encodeURIComponent(clientId)}`,
      `scope=${HUBRISE_SCOPES}`,
      `state=${encodeURIComponent(state)}`,
    ].join('&');

    this.logger.log(
      `[HubRise OAuth] ${userId} demande la connexion du restaurant ${restaurant.id}`,
    );

    return `${HUBRISE_OAUTH.AUTHORIZE}?${params}`;
  }

  /**
   * Traite le retour OAuth, dans cet ordre et sans raccourci :
   * 1. refus sur HubRise (`error`) ;
   * 2. `state` signé, non expiré, et son nonce à usage unique ;
   * 3. utilisateur relu en base : actif et toujours en droit de connecter ;
   * 4. restaurant existant ;
   * 5. SEULEMENT ALORS échange du code ;
   * 6. écriture contrôlée : ni restaurant déjà relié à une autre location, ni
   *    location déjà reliée à un autre restaurant. Tout refus après l'échange
   *    révoque le jeton qu'on vient d'obtenir, sauf s'il sert déjà à un
   *    restaurant (voir `revoquerJetonRefuse`).
   *
   * Ne lève jamais : le contrôleur redirige vers le backoffice avec le motif.
   * Le `state` brut n'est jamais journalisé.
   */
  async traiterRetour(query: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
  }): Promise<ResultatRetourHubrise> {
    if (query.error !== undefined) {
      this.logger.log('[HubRise OAuth] Connexion refusée sur HubRise.');
      return { ok: false, motif: 'refuse' };
    }

    const { code, state } = query;
    if (typeof code !== 'string' || !code || code.length > LONGUEUR_MAX_CODE) {
      this.logger.warn('[HubRise OAuth] Retour sans code exploitable.');
      return { ok: false, motif: 'lien_invalide' };
    }

    let etat: ReturnType<typeof verifierEtat>;
    try {
      etat = verifierEtat(state, this.cleEtat(), Date.now());
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Clé de signature indisponible : ${error}`);
      return { ok: false, motif: 'echec' };
    }
    if (!etat.ok) {
      this.logger.warn(`[HubRise OAuth] Retour refusé : ${etat.motif}.`);
      return { ok: false, motif: etat.motif };
    }

    const { restaurantId, userId, nonce } = etat;

    // Nonce à usage unique. Lecture puis suppression : pas atomique, mais la
    // fenêtre de course est négligeable devant la signature et l'expiration.
    const cleNonce = cleCacheNonce(nonce);
    let enCache: string | undefined;
    try {
      enCache = await this.cache.get<string>(cleNonce);
      if (enCache !== undefined) await this.cache.del(cleNonce);
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Cache indisponible : ${error}`);
      return { ok: false, motif: 'echec' };
    }
    if (enCache !== valeurNonce(restaurantId, userId)) {
      this.logger.warn(
        `[HubRise OAuth] Lien déjà utilisé ou inconnu (restaurant ${restaurantId}, utilisateur ${userId}).`,
      );
      return { ok: false, motif: 'lien_invalide' };
    }

    const utilisateur = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, entity_status: true },
    });
    if (
      !utilisateur ||
      utilisateur.entity_status !== EntityStatus.ACTIVE ||
      !peutConnecterHubrise(utilisateur.role)
    ) {
      this.logger.warn(`[HubRise OAuth] ${userId} n'a pas le droit de connecter ${restaurantId}.`);
      return { ok: false, motif: 'droit_insuffisant' };
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
    });
    if (!restaurant) {
      this.logger.warn(`[HubRise OAuth] Restaurant ${restaurantId} introuvable au retour.`);
      return { ok: false, motif: 'echec' };
    }

    const tokenData = await this.echangerCode(code);
    if (!tokenData) return { ok: false, motif: 'echec' };

    const locationId = tokenData.location_id;
    if (!locationId) {
      // Jeton de compte et non de location : inutilisable ici.
      this.logger.warn('[HubRise OAuth] Jeton sans location : refusé.');
      await this.revoquerJetonRefuse(tokenData.access_token);
      return { ok: false, motif: 'echec' };
    }

    // Une erreur de base APRÈS l'échange laisserait un jeton valide chez
    // HubRise et inconnu chez nous : on le révoque aussi dans ce cas.
    let enregistre: boolean;
    try {
      enregistre = await this.enregistrerJeton(restaurantId, tokenData, locationId);
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Enregistrement du jeton impossible : ${error}`);
      await this.revoquerJetonRefuse(tokenData.access_token);
      return { ok: false, motif: 'echec' };
    }
    if (!enregistre) {
      await this.revoquerJetonRefuse(tokenData.access_token);
      return { ok: false, motif: 'deja_relie' };
    }

    this.logger.log(
      `[HubRise OAuth] ${userId} a relié ${restaurantId} à la location ${locationId} (${tokenData.location_name ?? 'sans nom'})`,
    );

    return { ok: true, accessToken: tokenData.access_token };
  }

  /**
   * Échange le code d'autorisation contre un access_token, SANS rien écrire.
   * @returns le jeton, ou null en cas d'échec (journalisé)
   */
  private async echangerCode(code: string): Promise<HubriseTokenResponse | null> {
    const config = await this.settingsService.getManyOrEnv({
      hubrise_client_id: 'HUBRISE_CLIENT_ID',
      hubrise_client_secret: 'HUBRISE_CLIENT_SECRET',
    });

    const clientId = config.hubrise_client_id;
    const clientSecret = config.hubrise_client_secret;
    if (!clientId || !clientSecret) {
      this.logger.error('[HubRise OAuth] client_id ou client_secret manquant : échange impossible.');
      return null;
    }

    try {
      // Postman collection : code, client_id, client_secret (pas de redirect_uri)
      const response = await fetch(HUBRISE_OAUTH.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`[HubRise OAuth] Erreur échange token (${response.status}) : ${error}`);
        return null;
      }

      const tokenData = (await response.json()) as HubriseTokenResponse;
      if (!tokenData?.access_token) {
        this.logger.error('[HubRise OAuth] Réponse sans access_token.');
        return null;
      }

      return tokenData;
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Erreur : ${error}`);
      return null;
    }
  }

  /**
   * Enregistre le jeton sur le restaurant, sans jamais écraser une autre
   * liaison :
   * - la location ne doit être reliée à AUCUN autre restaurant (le webhook et
   *   la synchro résolvent le restaurant par `findFirst` sur la location) ;
   * - le restaurant doit être libre, ou déjà relié à CETTE location
   *   (reconnexion). Condition portée par l'écriture elle-même.
   *
   * @returns false si la liaison est refusée (rien n'a été écrit)
   */
  private async enregistrerJeton(
    restaurantId: string,
    tokenData: HubriseTokenResponse,
    locationId: string,
  ): Promise<boolean> {
    const autre = await this.prisma.restaurant.findFirst({
      where: { hubrise_location_id: locationId, id: { not: restaurantId } },
      select: { id: true },
    });
    if (autre) {
      this.logger.warn(
        `[HubRise OAuth] Location ${locationId} déjà reliée au restaurant ${autre.id} : refus pour ${restaurantId}.`,
      );
      return false;
    }

    const { count } = await this.prisma.restaurant.updateMany({
      where: {
        id: restaurantId,
        entity_status: { not: EntityStatus.DELETED },
        OR: [{ hubrise_location_id: null }, { hubrise_location_id: locationId }],
      },
      data: {
        hubrise_access_token: tokenData.access_token,
        hubrise_location_id: locationId,
        hubrise_catalog_id: tokenData.catalog_id ?? null,
        hubrise_customer_list_id: tokenData.customer_list_id ?? null,
      },
    });

    if (count !== 1) {
      this.logger.warn(
        `[HubRise OAuth] Restaurant ${restaurantId} déjà relié à une autre location : refus de ${locationId}.`,
      );
      return false;
    }

    return true;
  }

  /**
   * Révoque un jeton obtenu au retour puis refusé, SAUF s'il est déjà
   * enregistré sur un restaurant. HubRise peut renvoyer le jeton d'une
   * connexion existante (même client, même location) : le révoquer couperait
   * alors la liaison légitime de l'autre restaurant (cas typique : un ADMIN
   * qui relie par erreur la location d'un autre restaurant, refus deja_relie).
   * En cas de doute (base injoignable), on ne révoque pas.
   */
  private async revoquerJetonRefuse(accessToken: string): Promise<void> {
    try {
      const titulaire = await this.prisma.restaurant.findFirst({
        where: { hubrise_access_token: accessToken },
        select: { id: true },
      });
      if (titulaire) {
        this.logger.warn(
          `[HubRise OAuth] Jeton refusé mais déjà utilisé par le restaurant ${titulaire.id} : conservé.`,
        );
        return;
      }
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Contrôle du jeton impossible, révocation abandonnée : ${error}`);
      return;
    }

    await this.revokeToken(accessToken);
  }

  /**
   * Récupère le token HubRise d'un restaurant.
   * @returns Le token ou null si le restaurant n'est pas connecté
   */
  async getTokenForRestaurant(restaurantId: string): Promise<string | null> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { hubrise_access_token: true },
    });

    return restaurant?.hubrise_access_token ?? null;
  }

  /**
   * Récupère les infos HubRise d'un restaurant.
   */
  async getHubriseInfoForRestaurant(restaurantId: string) {
    return this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        hubrise_access_token: true,
        hubrise_location_id: true,
        hubrise_catalog_id: true,
        hubrise_customer_list_id: true,
      },
    });
  }

  /**
   * Déconnecte un restaurant de HubRise.
   * 1. Révoque le token côté HubRise (POST /oauth2/v1/revoke avec Basic Auth)
   * 2. Supprime les données OAuth en base
   */
  async disconnectRestaurant(restaurantId: string): Promise<void> {
    // Récupérer le token avant de le supprimer pour le révoquer
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { hubrise_access_token: true },
    });

    // Révoquer le token côté HubRise
    if (restaurant?.hubrise_access_token) {
      await this.revokeToken(restaurant.hubrise_access_token);
    }

    // Supprimer les données OAuth en base
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        hubrise_access_token: null,
        hubrise_location_id: null,
        hubrise_catalog_id: null,
        hubrise_customer_list_id: null,
      },
    });

    this.logger.log(`[HubRise] Restaurant ${restaurantId} déconnecté de HubRise`);
  }

  /**
   * Révoque un access_token auprès de HubRise.
   * POST /oauth2/v1/revoke avec Basic Auth (client_id:client_secret)
   * et le token dans le body.
   */
  private async revokeToken(accessToken: string): Promise<void> {
    const config = await this.settingsService.getManyOrEnv({
      hubrise_client_id: 'HUBRISE_CLIENT_ID',
      hubrise_client_secret: 'HUBRISE_CLIENT_SECRET',
    });

    const clientId = config.hubrise_client_id;
    const clientSecret = config.hubrise_client_secret;

    if (!clientId || !clientSecret) {
      this.logger.warn('[HubRise OAuth] Impossible de révoquer — client_id ou client_secret manquant');
      return;
    }

    try {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await fetch(HUBRISE_OAUTH.REVOKE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });

      if (response.ok) {
        this.logger.log('[HubRise OAuth] Token révoqué avec succès');
      } else {
        const error = await response.text();
        this.logger.warn(`[HubRise OAuth] Erreur révocation token : ${error}`);
      }
    } catch (error) {
      // Ne pas bloquer la déconnexion locale si la révocation échoue
      this.logger.warn(`[HubRise OAuth] Erreur réseau lors de la révocation : ${error}`);
    }
  }

  /**
   * Vérifie si un restaurant est connecté à HubRise.
   */
  async isRestaurantConnected(restaurantId: string): Promise<boolean> {
    const token = await this.getTokenForRestaurant(restaurantId);
    return !!token;
  }

  /**
   * Récupère tous les restaurants connectés à HubRise.
   */
  async getConnectedRestaurants() {
    return this.prisma.restaurant.findMany({
      where: {
        hubrise_access_token: { not: null },
        hubrise_location_id: { not: null },
      },
      select: {
        id: true,
        name: true,
        hubrise_location_id: true,
        hubrise_catalog_id: true,
      },
    });
  }

}
