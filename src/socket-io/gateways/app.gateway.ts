import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';

import type { ExtendedError, Namespace, Server, Socket } from 'socket.io';
import { EntityStatus, PresenceCheckResponse } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  JsonWebTokenService,
  MESSAGE_JETON_EXPIRE,
} from 'src/json-web-token/json-web-token.service';
import { ConnectedUser } from '../interfaces/app.gateway.interface';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { sansSecretsRestaurant } from 'src/common/utils/restaurant-secrets.util';
import { sansTelephoneClientTermine } from 'src/common/securite/telephone-client-livreur';
import { JournalLimite, suffixeTues } from 'src/common/utils/journal-limite.util';
import {
  SALLE_BACKOFFICE,
  SALLE_CLIENTS,
  SALLE_PERSONNEL,
  SALLE_RELANCES,
  livreurDeLaSalle,
  salleLivreur,
  salleLivreursRestaurant,
  sallePersonnelle,
  sallesAJoindre,
  sallesDiffusionRestaurant,
  sallesLivreursARetirer,
  salleUtilisateur,
} from '../utils/salles.util';
import {
  EVENEMENT_LIVREUR_CONNECTE,
  EVENEMENT_LIVREUR_DECONNECTE,
  LivreurDeconnecte,
} from '../utils/evenements-connexion.util';
import {
  ATTENTES_REPRISE_MS,
  BUDGET_IDENTIFICATION_MS,
  EVENEMENT_CONNEXION_ACCEPTEE,
  LIBELLE_TYPE,
  MotifRefusConnexion,
  TypeConnexion,
  codeErreur,
  court,
  erreurRefus,
  estErreurPassagere,
  lireIdentifiants,
  sujetNonVerifie,
} from '../utils/connexion-socket.util';

// Interface pour le cache
interface CachedUser {
  data: ConnectedUser;
  expiresAt: number;
}

/** Ce que le contrôle d'entrée laisse sur le socket accepté. */
interface DonneesSocket {
  identite?: ConnectedUser;
  /** Version annoncée par l'appli (`version` dans `auth` ou la requête), pour le journal. */
  version?: string | null;
}

/** Issue de l'identification : compte trouvé, absent (`null`), ou base muette. */
type IssueIdentification =
  | { panne: false; identite: ConnectedUser | null }
  | { panne: true; erreur: unknown };

/** Au-delà, la présence d'un livreur est déclarée inconnue (Redis ou une autre instance trop lents). */
const DELAI_PRESENCE_MS = 1500;

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/app', // Namespace global pour toute l'app
})
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AppGateway.name);

  @WebSocketServer()
  server: Server;

  private connectedUsers = new Map<string, ConnectedUser>();

  // Cache pour éviter de spammer la DB lors des boucles de connexion
  private authCache = new Map<string, CachedUser>();
  private readonly CACHE_TTL_MS = 10000; // Le cache dure 10 secondes
  private readonly CACHE_MAX_SIZE = 2000;

  /**
   * Au plus une ligne par minute et par clé pour les refus, les pannes et les
   * connexions des livreurs : une vague de reconnexions ne noie pas le journal.
   */
  private readonly journalLimite = new JournalLimite(60_000);

  /** Attentes avant les nouveaux essais d'identification (remplacées dans les tests). */
  protected attentesRepriseMs: readonly number[] = ATTENTES_REPRISE_MS;

  // Map pour tracker qui est en train d'écrire dans quelle conversation
  private typingUsers = new Map<string, Set<string>>(); // conversationId -> Set<userId>
  private typingTimeouts = new Map<string, NodeJS.Timeout>(); // userId -> timeout

  constructor(
    private prisma: PrismaService,
    private jwtService: JsonWebTokenService,
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Branche le contrôle d'entrée sur l'espace `/app` : chaque connexion est
   * jugée AVANT que le client ne reçoive « connect » (contrat complet dans
   * `connexion-socket.util.ts`).
   */
  afterInit(espace: Namespace) {
    espace.use((socket, next) => {
      void this.controlerEntree(socket, next);
    });
  }

  /**
   * Contrôle d'entrée d'une connexion. Trois issues, jamais muettes :
   *  - acceptée : identité posée sur le socket, salles rejointes, puis `next()` ;
   *  - refusée : `next(erreur)`, le client reçoit `connect_error` avec le motif ;
   *  - panne passagère (base) : transport fermé, le client se reconnecte seul.
   */
  async controlerEntree(socket: Socket, next: (err?: ExtendedError) => void): Promise<void> {
    let type: TypeConnexion | null = null;
    let sujet: string | null = null;
    try {
      const identifiants = lireIdentifiants(socket.handshake);
      type = identifiants.type;
      const version = identifiants.version;
      if (!identifiants.token) return this.refuser(next, 'JETON_ABSENT', type, null, version);
      if (!type) return this.refuser(next, 'TYPE_INVALIDE', null, null, version);

      let decoded: { sub?: unknown };
      try {
        decoded = await this.jwtService.verifyToken(identifiants.token, type);
      } catch (erreur) {
        const expire = (erreur as Error)?.message === MESSAGE_JETON_EXPIRE;
        return this.refuser(
          next,
          expire ? 'JETON_EXPIRE' : 'JETON_INVALIDE',
          type,
          expire ? sujetNonVerifie(identifiants.token) : null,
          version,
        );
      }

      sujet = typeof decoded?.sub === 'string' ? decoded.sub : null;
      if (!sujet) return this.refuser(next, 'COMPTE_INCONNU', type, null, version);

      const issue = await this.identifierAvecReprise(sujet, type);
      if (issue.panne) return this.reporter(socket, next, type, sujet, issue.erreur);
      if (!issue.identite) return this.refuser(next, 'COMPTE_INCONNU', type, sujet, version);

      // Salles rejointes AVANT « connect » : accepté veut dire joignable. Si le
      // client est parti pendant l'attente, socket.io écarte ce socket et le
      // retire de ses salles.
      const donnees = socket.data as DonneesSocket;
      donnees.identite = issue.identite;
      donnees.version = version;
      await socket.join(sallesAJoindre(issue.identite));
      next();
    } catch (erreur) {
      // Imprévu : ni refus ni acceptation, le client réessaie seul.
      this.reporter(socket, next, type, sujet, erreur);
    }
  }

  private refuser(
    next: (err?: ExtendedError) => void,
    motif: MotifRefusConnexion,
    type: TypeConnexion | null,
    sujet: string | null = null,
    version: string | null = null,
  ): void {
    // Clients : une ligne par motif et par minute, pas une par appareil.
    const cle = `refus:${motif}:${type ?? '-'}:${type === 'customer' ? '' : (sujet ?? '')}`;
    const tues = this.journalLimite.autoriser(cle);
    if (tues !== null) {
      const qui = type ? `${LIBELLE_TYPE[type]}${sujet ? ` ${court(sujet)}` : ''}` : 'type inconnu';
      this.logger.warn(
        `Connexion refusée (${motif}) : ${qui}${version ? ` (appli ${version})` : ''}${suffixeTues(tues)}`,
      );
    }
    next(erreurRefus(motif));
  }

  /**
   * Panne passagère : ni refus ni acceptation. Le transport est fermé, le
   * client voit « transport close » et socket.io se reconnecte seul, sur la
   * même instance, écouteurs intacts (anciennes versions des applis
   * comprises). `next` est appelé ensuite pour que socket.io oublie ce socket :
   * le transport n'étant plus ouvert, il ne renvoie rien au client.
   */
  private reporter(
    socket: Socket,
    next: (err?: ExtendedError) => void,
    type: TypeConnexion | null,
    sujet: string | null,
    erreur: unknown,
  ): void {
    const tues = this.journalLimite.autoriser(`panne:${type ?? '-'}`);
    if (tues !== null) {
      const qui = type ? `${LIBELLE_TYPE[type]} ${court(sujet)}` : 'inconnue';
      this.logger.warn(
        `Connexion ${qui} reportée (${codeErreur(erreur)}) : le client va se reconnecter seul${suffixeTues(tues)}`,
      );
    }
    socket.conn.close();
    next(new Error('SERVICE_INDISPONIBLE'));
  }

  /**
   * Identité du compte, avec quelques nouveaux essais si la base ne répond
   * pas. Une erreur définitive (requête mal formée) vaut « compte inconnu ».
   */
  private async identifierAvecReprise(sujet: string, type: TypeConnexion): Promise<IssueIdentification> {
    const debut = Date.now();
    for (let essai = 0; ; essai++) {
      try {
        return { panne: false, identite: await this.identifyUser({ sub: sujet }, type) };
      } catch (erreur) {
        if (!estErreurPassagere(erreur)) {
          this.logger.warn(
            `Identification ${LIBELLE_TYPE[type]} ${court(sujet)} impossible (${codeErreur(erreur)}) : compte tenu pour inconnu`,
          );
          return { panne: false, identite: null };
        }
        const attente = this.attentesRepriseMs[essai];
        if (attente === undefined || Date.now() - debut + attente > BUDGET_IDENTIFICATION_MS) {
          return { panne: true, erreur };
        }
        await new Promise((resoudre) => setTimeout(resoudre, attente));
      }
    }
  }

  /**
   * Connexion acceptée par le contrôle d'entrée : le socket est déjà dans ses
   * salles. Reste à le compter, à l'accuser au client et à prévenir les
   * modules qui en dépendent.
   */
  handleConnection(client: Socket) {
    const identite = (client.data as DonneesSocket | undefined)?.identite;
    if (!identite) {
      // Contrôle d'entrée absent : ne doit pas arriver. Refus visible plutôt
      // qu'un socket sans salle qui n'entendrait rien.
      this.logger.error(`Socket ${client.id} arrivé sans contrôle d'entrée : coupé`);
      client.disconnect(true);
      return;
    }

    this.connectedUsers.set(client.id, { ...identite, socketId: client.id });
    client.emit(EVENEMENT_CONNEXION_ACCEPTEE, { type: identite.type, id: identite.id });

    if (identite.type === 'deliverer') {
      const depuis = Date.now();
      const version = (client.data as DonneesSocket).version;
      this.journaliserLivreur(
        identite.id,
        'connecte',
        `connecté (socket ${client.id}${version ? `, appli ${version}` : ''})`,
      );
      client.once('disconnect', (raison: string) => {
        this.journaliserLivreur(
          identite.id,
          'deconnecte',
          `déconnecté (${raison}) après ${dureeLisible(Date.now() - depuis)}`,
        );
        // Raison gardée (FinsSocketLivreursService) : « Appli fermée » seulement
        // quand l'appli a fermé elle-même son socket, sinon « Connexion coupée ».
        const fin: LivreurDeconnecte = { delivererId: identite.id, raison, a: new Date().toISOString() };
        this.eventEmitter.emit(EVENEMENT_LIVREUR_DECONNECTE, fin);
      });
      // Check de présence matinal en attente aujourd'hui : renvoyé tout de
      // suite (reconnexion sur un autre appareil après le cron de 8 h).
      void this.sendPendingPresenceCheck(client, identite.id);
      // Offre en attente : renvoyée par le module course (DispatchListener).
      this.eventEmitter.emit(EVENEMENT_LIVREUR_CONNECTE, { delivererId: identite.id });
    }

    // Agents support (type='user') : le module support ré-enfile les tickets
    // en attente sur leurs catégories (file épuisée avant leur arrivée).
    if (identite.type === 'user') {
      this.eventEmitter.emit('user.online', { userId: identite.id });
    }
  }

  /** Connexion et déconnexion d'un livreur : une ligne par minute au plus pour chacune. */
  private journaliserLivreur(delivererId: string, quoi: 'connecte' | 'deconnecte', texte: string): void {
    const tues = this.journalLimite.autoriser(`livreur:${quoi}:${delivererId}`);
    if (tues === null) return;
    this.logger.log(`Livreur ${court(delivererId)} ${texte}${suffixeTues(tues)}`);
  }

  handleDisconnect(client: Socket) {
    const user = this.connectedUsers.get(client.id);
    if (user) {
      this.connectedUsers.delete(client.id);

      // Supprimer les typing indicators
      this.cleanupUserTypingOnDisconnect(user.id);
    }
  }

  /**
   * Vérifie si un utilisateur est en ligne (par son id)
   * @param userId ID de l'utilisateur
   * @returns true si l'utilisateur est en ligne, false sinon
   */
  isUserOnline(userId: string): boolean {
    for (const user of this.connectedUsers.values()) {
      if (user.id === userId) {
        return true;
      }
    }
    return false;
  }

  // ================================
  // PRÉSENCE DES LIVREURS
  // ================================

  /**
   * Livreurs qui ont au moins un socket ouvert dans leur canal privé, toutes
   * instances comprises (adaptateur Redis). `null` : présence inconnue (Redis
   * ou une autre instance n'a pas répondu à temps), à ne pas confondre avec
   * « pas connecté ».
   *
   * Aucun socket : l'appli ne recevra rien en temps réel, seulement les
   * notifications. Un socket ouvert ne prouve pas que l'appli l'écoute, mais
   * c'est tout ce que le serveur peut voir.
   */
  async livreursConnectes(delivererIds: readonly string[]): Promise<Set<string> | null> {
    const connectes = new Set<string>();
    if (delivererIds.length === 0) return connectes;
    if (!this.server) return null;
    const voulus = new Set(delivererIds);
    let minuterie: NodeJS.Timeout | undefined;
    try {
      const delai = new Promise<null>((resoudre) => {
        minuterie = setTimeout(() => resoudre(null), DELAI_PRESENCE_MS);
      });
      const sockets = await Promise.race([
        this.server.in([...voulus].map(salleLivreur)).fetchSockets(),
        delai,
      ]);
      if (!sockets) return null;
      for (const socket of sockets) {
        for (const salle of socket.rooms) {
          const id = livreurDeLaSalle(salle);
          if (id && voulus.has(id)) connectes.add(id);
        }
      }
      return connectes;
    } catch {
      return null;
    } finally {
      clearTimeout(minuterie);
    }
  }

  /** Un livreur a-t-il un socket ouvert ? `null` : on ne sait pas. */
  async livreurConnecte(delivererId: string): Promise<boolean | null> {
    const connectes = await this.livreursConnectes([delivererId]);
    return connectes ? connectes.has(delivererId) : null;
  }

  /**
   * Identifie l'utilisateur en utilisant un Cache pour protéger la DB.
   *
   * `null` : compte introuvable ou plus actif. Une erreur de base REMONTE :
   * elle ne dit rien du compte, et la confondre avec « introuvable » coupait
   * le socket du livreur pour de bon.
   */
  private async identifyUser(
    decoded: { sub: string },
    type: 'user' | 'customer' | 'deliverer',
  ): Promise<ConnectedUser | null> {
    if (!decoded.sub) return null;

    const cacheKey = `${type}_${decoded.sub}`;
    const now = Date.now();

    // 1. Vérification du Cache
    if (this.authCache.has(cacheKey)) {
      const cached = this.authCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        // Retourner la version en mémoire sans toucher la DB
        return cached.data;
      } else {
        this.authCache.delete(cacheKey);
      }
    }

    // 2. Requête Base de données (uniquement si pas en cache)
    let result: ConnectedUser | null = null;

    if (type === 'customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
        select: { id: true } // Optimisation : on ne prend que l'ID
      });

      if (customer) {
        result = {
          id: customer.id,
          type: 'customer',
          socketId: '',
        };
      }
    } else if (type === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
        // Seuls le type, le rattachement et le rôle servent : inutile de
        // charger la ligne du restaurant, et avec elle sa clé Turbo et son
        // jeton HubRise. Le rôle décide de la salle des relances.
        select: { id: true, type: true, restaurant_id: true, role: true },
      });

      if (user) {
        result = {
          id: user.id,
          type: 'user',
          userType: user.type,
          restaurantId: user.restaurant_id ?? undefined,
          role: user.role,
          socketId: '',
        };
      }
    } else if (type === 'deliverer') {
      // Le livreur se connecte au WS même en PENDING_VALIDATION pour recevoir
      // l'event deliverer.operational.changed dès qu'un admin le valide.
      const deliverer = await this.prisma.deliverer.findUnique({
        where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
        select: { id: true, restaurant_id: true },
      });

      if (deliverer) {
        result = {
          id: deliverer.id,
          type: 'deliverer',
          restaurantId: deliverer.restaurant_id ?? undefined,
          socketId: '',
        };
      }
    }

    // 3. Mise en cache du résultat
    if (result) {
      this.authCache.set(cacheKey, {
        data: result,
        expiresAt: now + this.CACHE_TTL_MS, // Valide 10 secondes
      });

      // Nettoyage LRU si le cache devient trop gros
      if (this.authCache.size > this.CACHE_MAX_SIZE) {
        this.evictCache(now);
      }
    }

    return result;
  }

  /**
   * Éviction progressive du cache : supprime d'abord les entrées expirées,
   * puis les plus anciennes si le cache dépasse toujours la limite.
   */
  private evictCache(now: number) {
    // Phase 1 : Supprimer toutes les entrées expirées
    for (const [key, cached] of this.authCache) {
      if (cached.expiresAt <= now) {
        this.authCache.delete(key);
      }
    }

    // Phase 2 : Si toujours au-dessus de la limite, supprimer les plus anciennes
    if (this.authCache.size > this.CACHE_MAX_SIZE) {
      const entries = Array.from(this.authCache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);

      const toRemove = this.authCache.size - this.CACHE_MAX_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.authCache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Le détail des salles, et pourquoi le livreur ne rejoint plus
   * `restaurant_{id}`, est dans `salles.util.ts`.
   */
  private async joinRooms(client: Socket, userInfo: ConnectedUser) {
    await client.join(sallesAJoindre(userInfo));
  }

  // ================================
  // RÉVOCATION DES SALLES
  // ================================
  // Les salles sont fixées à la connexion. Sans ces deux méthodes, un livreur
  // réaffecté ou supprimé, un compte du personnel désactivé ou supprimé,
  // gardaient leurs salles jusqu'à la prochaine reconnexion de leur appareil.
  // Les deux passent par l'adaptateur Redis : elles atteignent le socket quelle
  // que soit l'instance où il est connecté. Elles sont appelées par
  // `RevocationSallesListener`, sur les événements internes des modules
  // livreurs et utilisateurs.

  /**
   * Place les sockets d'un livreur dans la salle des livreurs de son restaurant
   * actuel, et les retire de toute autre. `restaurantId` à `null` : aucune.
   *
   * Le canal privé `deliverer_{id}` n'est pas touché : le livreur continue de
   * recevoir son changement de statut, même quand son compte vient d'être
   * suspendu ou supprimé.
   */
  async resynchroniserSallesLivreur(delivererId: string, restaurantId: string | null): Promise<void> {
    // La prochaine connexion relira la fiche au lieu du cache
    this.authCache.delete(`deliverer_${delivererId}`);
    for (const connexion of this.connectedUsers.values()) {
      if (connexion.type === 'deliverer' && connexion.id === delivererId) {
        connexion.restaurantId = restaurantId ?? undefined;
      }
    }

    if (!this.server) return;
    const salleCible = restaurantId ? salleLivreursRestaurant(restaurantId) : null;
    const sockets = await this.server.in(salleLivreur(delivererId)).fetchSockets();
    for (const socket of sockets) {
      for (const salle of sallesLivreursARetirer(socket.rooms, salleCible)) {
        await socket.leave(salle);
      }
      if (salleCible && !socket.rooms.has(salleCible)) {
        await socket.join(salleCible);
      }
    }
  }

  /**
   * Coupe les sockets d'un membre du personnel (compte désactivé ou supprimé).
   * La reconnexion est refusée ensuite : `identifyUser` exige un compte actif.
   * Une coupure décidée par le serveur n'est pas relancée d'elle-même par le
   * client socket.io.
   */
  deconnecterUtilisateur(userId: string): void {
    this.authCache.delete(`user_${userId}`);
    if (!this.server) return;
    this.server.in(salleUtilisateur(userId)).disconnectSockets(true);
  }

  // ================================
  // CHECK DE PRÉSENCE À LA CONNEXION
  // ================================

  /**
   * Si un `DailyPresenceCheck` du jour est en attente de réponse (NO_RESPONSE),
   * on l'émet directement sur le socket du livreur qui vient de se connecter.
   *
   * Couvre le cas de reconnexion tardive : le cron `dailyPresenceCheckPush` a
   * déjà tourné (ex. 8h) mais le livreur était offline. À sa prochaine connexion
   * (même sur un autre appareil), il reçoit quand même la question.
   */
  private async sendPendingPresenceCheck(client: Socket, delivererId: string) {
    try {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      const check = await this.prisma.dailyPresenceCheck.findFirst({
        where: {
          deliverer_id: delivererId,
          date: todayStart,
          response: PresenceCheckResponse.NO_RESPONSE,
        },
        select: { date: true },
      });

      if (check) {
        client.emit('schedule:presence-check:request', {
          delivererId,
          date: check.date.toISOString().substring(0, 10),
          shiftType: null,
        });
      }
    } catch {
      // Silencieux — ne bloque pas la connexion WS
    }
  }

  // ================================
  // MÉTHODES D'ÉMISSION GÉNÉRIQUES
  // ================================
  // Toutes passent par `sansSecretsRestaurant` : `backoffice_all` réunit tout
  // compte BACKOFFICE quel que soit son rôle, et aucun membre d'une salle ne
  // doit recevoir la clé Turbo ni le jeton HubRise d'un restaurant, même si une
  // requête en amont charge la ligne complète. Qui entend quoi : voir
  // `salles.util.ts`.
  // Vers un livreur, en plus, `sansTelephoneClientTermine` : plus de numéro du
  // client pour une livraison terminée ou une course close. La même course
  // part au siège et au restaurant avec le numéro : elle n'est pas modifiée.

  // Émettre à un utilisateur spécifique
  emitToUser<T>(
    userId: string,
    userType: 'customer' | 'user' | 'deliverer',
    event: string,
    data: T,
  ) {
    const charge = userType === 'deliverer' ? sansTelephoneClientTermine(data) : data;
    this.server.to(sallePersonnelle(userType, userId)).emit(event, sansSecretsRestaurant(charge));
  }

  // Émettre à un livreur spécifique (alias sémantique)
  emitToDeliverer<T>(delivererId: string, event: string, data: T) {
    this.server
      .to(salleLivreur(delivererId))
      .emit(event, sansSecretsRestaurant(sansTelephoneClientTermine(data)));
  }

  // Émettre à tous les backoffice
  emitToBackoffice<T>(event: string, data: T) {
    this.server.to(SALLE_BACKOFFICE).emit(event, sansSecretsRestaurant(data));
  }

  /**
   * Émettre au personnel d'un restaurant (caisse, cuisine, gérant).
   *
   * Les livreurs du restaurant ne reçoivent que les événements de
   * `EVENEMENTS_RESTAURANT_POUR_LIVREURS` (aujourd'hui la file d'attente) :
   * commandes, courses, tickets et messages des clients restent au personnel.
   * Une seule émission vers les deux salles : aucun socket ne la reçoit deux fois.
   */
  emitToRestaurant<T>(restaurantId: string, event: string, data: T) {
    this.server
      .to(sallesDiffusionRestaurant(restaurantId, event))
      .emit(event, sansSecretsRestaurant(data));
  }

  /**
   * Émettre aux rôles qui suivent les paniers non payés (ADMIN, CALL_CENTER).
   * Seul `relance:changed` y part, sans donnée personnelle.
   */
  emitToRelances<T>(event: string, data: T) {
    this.server.to(SALLE_RELANCES).emit(event, sansSecretsRestaurant(data));
  }

  /**
   * Émettre à toutes les apps clientes (`customers`) ou à tout le personnel
   * (`users`). Jamais de donnée propre à une personne : chaque client connecté
   * la recevrait.
   */
  emitToUserType<T>(userType: 'customers' | 'users', event: string, data: T) {
    const salle = userType === 'customers' ? SALLE_CLIENTS : SALLE_PERSONNEL;
    this.server.to(salle).emit(event, sansSecretsRestaurant(data));
  }

  /**
   * Émettre à TOUS les sockets connectés, clients et livreurs compris.
   *
   * @deprecated Sans appel effectif : son seul appelant,
   * `NotificationsWebSocketService.broadcast`, n'est lui-même appelé nulle part.
   * Tout ce qui partirait par ici atteindrait chaque client connecté : cibler
   * une salle.
   */
  broadcast<T>(event: string, data: T) {
    this.server.emit(event, sansSecretsRestaurant(data));
  }

  /**
   * `pong` dans le canal privé, comme avant. Avec un accusé
   * (`socket.timeout(5000).emitWithAck('ping')`), l'appli apprend aussi si le
   * serveur connaît toujours ce socket : `{ connecte: true }`.
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return { connecte: false };
    this.emitToUser(
      user.id,
      user.type,
      'pong',
      `pong from ${user.type} ${user.id}`,
    );
    return { connecte: true };
  }

  @SubscribeMessage('user_typing_start')
  handleUserTypingStart(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return;

    this.notifyUserTyping(data.conversationId, user.id, user.type, true);
  }

  @SubscribeMessage('user_typing_stop')
  handleUserTypingStop(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return;

    this.notifyUserTyping(data.conversationId, user.id, user.type, false);
  }

  /**
   * Gère les indicateurs "X est en train d'écrire..."
   */
  notifyUserTyping(
    conversationId: string,
    userId: string,
    userType: 'user' | 'customer' | 'deliverer',
    isTyping: boolean,
    userName?: string,
  ) {
    try {
      const typingKey = `${userId}_${conversationId}`;

      if (isTyping) {
        // Ajouter l'utilisateur à la liste des "en train d'écrire"
        if (!this.typingUsers.has(conversationId)) {
          this.typingUsers.set(conversationId, new Set());
        }
        this.typingUsers.get(conversationId)!.add(userId);

        // Effacer le timeout précédent s'il existe
        if (this.typingTimeouts.has(typingKey)) {
          clearTimeout(this.typingTimeouts.get(typingKey)!);
        }

        // Auto-stop après 3 secondes d'inactivité
        const timeout = setTimeout(() => {
          this.notifyUserTyping(
            conversationId,
            userId,
            userType,
            false,
            userName,
          );
        }, 3000);

        this.typingTimeouts.set(typingKey, timeout);
      } else {
        // Retirer l'utilisateur de la liste
        if (this.typingUsers.has(conversationId)) {
          this.typingUsers.get(conversationId)!.delete(userId);

          // Supprimer la conversation si plus personne n'écrit
          if (this.typingUsers.get(conversationId)!.size === 0) {
            this.typingUsers.delete(conversationId);
          }
        }

        // Effacer le timeout
        if (this.typingTimeouts.has(typingKey)) {
          clearTimeout(this.typingTimeouts.get(typingKey)!);
          this.typingTimeouts.delete(typingKey);
        }
      }

      // Préparer la liste des utilisateurs en train d'écrire
      const typingUsersList = this.typingUsers.get(conversationId) || new Set();

      // Émettre à tous les participants SAUF à celui qui écrit
      this.server
        .to(`conversation_${conversationId}`)
        .except(
          // Trouver le socketId de l'utilisateur qui écrit
          Array.from(this.connectedUsers.entries())
            .filter(([, connectedUser]) => connectedUser.id === userId)
            .map(([socketId]) => socketId),
        )
        .emit('typing_indicator', {
          conversationId,
          typingUsers: Array.from(typingUsersList).filter(
            (id) => id !== userId,
          ),
          isTyping: typingUsersList.size > 0,
          userName: userName || `${userType} ${userId}`,
        });

      // this.logger.log(`Typing indicator: ${userId} ${isTyping ? 'started' : 'stopped'} typing in ${conversationId}`);

    } catch (error) {
      // this.logger.error('Error handling typing indicator:', error);
    }
  }

  /**
   * Nettoie les indicateurs de frappe quand un utilisateur se déconnecte
   * @param userId
   */
  private cleanupUserTypingOnDisconnect(userId: string) {
    // Parcourir toutes les conversations où cet utilisateur était en train d'écrire
    this.typingUsers.forEach((typingUsersSet, conversationId) => {
      if (typingUsersSet.has(userId)) {
        // userType 'user' par défaut pour la compatibilité ; le cleanup n'utilise
        // pas le type pour la logique, juste pour l'émission.
        this.notifyUserTyping(conversationId, userId, 'user', false);
      }
    });

    // Nettoyer les timeouts de cet utilisateur
    Array.from(this.typingTimeouts.keys())
      .filter((key) => key.startsWith(`${userId}_`))
      .forEach((key) => {
        clearTimeout(this.typingTimeouts.get(key)!);
        this.typingTimeouts.delete(key);
      });
  }

  // Getter pour les statistiques
  getConnectedUsers() {
    return this.connectedUsers;
  }

  getConnectionStats() {
    const stats = {
      total: this.connectedUsers.size,
      customers: 0,
      backoffice: 0,
      restaurants: new Map<string, number>(),
    };

    this.connectedUsers.forEach((user) => {
      if (user.type === 'customer') {
        stats.customers++;
      } else if (user.userType === 'BACKOFFICE') {
        stats.backoffice++;
      } else if (user.userType === 'RESTAURANT' && user.restaurantId) {
        const current = stats.restaurants.get(user.restaurantId) || 0;
        stats.restaurants.set(user.restaurantId, current + 1);
      }
    });

    return stats;
  }
}

/** « 42 s », « 3 min », « 2 h 05 » : durée d'une connexion dans le journal. */
function dureeLisible(ms: number): string {
  const secondes = Math.max(0, Math.round(ms / 1000));
  if (secondes < 120) return `${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}
