import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AvisRessenti, AvisSuiviType, EntityStatus, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { AvisPriveLimitesService } from './avis-prive-limites.service';
import { AvisPriveNotificationsTemplate, envoyerCloche } from './avis-prive-notifications.template';
import { CreerAvisPriveDto } from './avis-prive.dto';
import {
  chiffres,
  COMMENTAIRE_MIN,
  DELAI_DOUBLON_MS,
  empreinteCommentaire,
  etatInitial,
  EXTRAIT_CLOCHE,
  extrait,
  FENETRE_NUMERO_MS,
  formatJourHeure,
  MAX_AVIS_PAR_NUMERO,
  MESSAGE_COMMENTAIRE,
  MESSAGE_NUMERO,
  MESSAGE_PLAFOND_NUMERO,
  MESSAGE_STORE,
  mobileIvoirien,
  nettoyerCommentaire,
  nettoyerPrenom,
  prenomAffiche,
  SANS_PRENOM,
  sourceAutorisee,
  STORE_INCONNU,
  TEXTE_ALERTE,
  texteReception,
} from './avis-prive.rules';
import { AvisPriveService } from './avis-prive.service';

/** Réponse de l'envoi public : jamais l'identifiant ni rien d'autre. */
export const REPONSE_ENVOI = { ok: true } as const;

/**
 * Envoi PUBLIC d'un avis depuis la page « Ton avis compte » (contrat 4.1).
 *
 * Ordre : champ piège, numéro, store, doublon, plafonds, écriture, cloche.
 * Le champ piège et le doublon répondent comme un succès, sans rien écrire :
 * un robot n'apprend rien, un double appui ne crée pas deux avis.
 */
@Injectable()
export class AvisPriveDepotService {
  private readonly logger = new Logger(AvisPriveDepotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avis: AvisPriveService,
    private readonly limites: AvisPriveLimitesService,
    private readonly notifications: NotificationsService,
    private readonly ws: NotificationsWebSocketService,
    private readonly destinataires: NotificationRecipientService,
  ) {}

  async deposer(dto: CreerAvisPriveDto, maintenant = new Date()): Promise<typeof REPONSE_ENVOI> {
    if (champPiegeRempli(dto.site_web)) return REPONSE_ENVOI;

    const telephone = mobileIvoirien(dto.telephone);
    if (!telephone) throw new BadRequestException(MESSAGE_NUMERO);

    const commentaire = nettoyerCommentaire(dto.commentaire);
    if (commentaire.length < COMMENTAIRE_MIN) throw new BadRequestException(MESSAGE_COMMENTAIRE);

    const restaurant = dto.restaurant_id
      ? await this.prisma.restaurant.findFirst({
          where: { id: dto.restaurant_id, entity_status: EntityStatus.ACTIVE },
          select: { id: true, name: true },
        })
      : null;
    if (dto.restaurant_id && !restaurant) throw new BadRequestException(MESSAGE_STORE);

    const reservation = await this.limites.reserver(chiffres(telephone), empreinteCommentaire(commentaire));
    if (reservation.etat === 'doublon') return REPONSE_ENVOI;
    if (reservation.etat === 'panne' && (await this.repliEnBase(telephone, commentaire, maintenant))) {
      return REPONSE_ENVOI;
    }

    const accordRappel = dto.accord_rappel === true;
    const prenom = nettoyerPrenom(dto.prenom);
    const { statut, echeance_at } = etatInitial(dto.ressenti, accordRappel, maintenant);

    let avisId: string;
    let client: { id: string; first_name: string | null } | null;
    try {
      client = await this.avis.trouverClient(telephone);
      avisId = await this.prisma.$transaction(async (tx) => {
        const cree = await tx.avisPrive.create({
          data: {
            ressenti: dto.ressenti,
            canal: dto.canal,
            restaurant_id: restaurant?.id ?? null,
            commentaire,
            telephone,
            prenom,
            accord_rappel: accordRappel,
            source: sourceAutorisee(dto.source),
            customer_id: client?.id ?? null,
            rapproche_at: client ? maintenant : null,
            statut,
            echeance_at,
            created_at: maintenant,
            updated_at: maintenant,
          },
          select: { id: true },
        });
        await tx.avisPriveSuivi.create({
          data: {
            avis_id: cree.id,
            type: AvisSuiviType.SYSTEME,
            note: texteReception({ rapproche: !!client, statut, accordRappel }),
            statut_apres: statut,
            created_at: maintenant,
          },
        });
        return cree.id;
      });
    } catch (erreur) {
      await this.limites.annuler(reservation);
      throw erreur;
    }

    if (dto.ressenti === AvisRessenti.PAS_CONTENT) {
      await this.alerterPasContent({
        avisId,
        nom: prenomAffiche(prenom, client?.first_name) ?? SANS_PRENOM,
        store: restaurant?.name ?? STORE_INCONNU,
        commentaire,
        echeance: echeance_at,
      });
    }
    return REPONSE_ENVOI;
  }

  /**
   * Redis en panne : les barrières se replient sur la base. Un avis identique
   * reçu dans les 10 dernières minutes vaut doublon (`true`, rien à écrire) ;
   * trois avis du numéro sur 24 h valent 429.
   */
  private async repliEnBase(telephone: string, commentaire: string, maintenant: Date): Promise<boolean> {
    const doublon = await this.prisma.avisPrive.findFirst({
      where: {
        telephone,
        commentaire,
        entity_status: { not: EntityStatus.DELETED },
        created_at: { gte: new Date(maintenant.getTime() - DELAI_DOUBLON_MS) },
      },
      select: { id: true },
    });
    if (doublon) return true;
    const recus = await this.prisma.avisPrive.count({
      where: { telephone, created_at: { gte: new Date(maintenant.getTime() - FENETRE_NUMERO_MS) } },
    });
    if (recus >= MAX_AVIS_PAR_NUMERO) {
      throw new HttpException(MESSAGE_PLAFOND_NUMERO, HttpStatus.TOO_MANY_REQUESTS);
    }
    return false;
  }

  /**
   * Cloche des comptes du siège ADMIN et CALL_CENTER (jamais du restaurant)
   * pour un client pas content, une fois, à la réception. Un échec est
   * journalisé et avalé : l'avis est déjà enregistré.
   */
  private async alerterPasContent(p: {
    avisId: string;
    nom: string;
    store: string;
    commentaire: string;
    echeance: Date | null;
  }): Promise<void> {
    try {
      const siege = await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.ADMIN, UserRole.CALL_CENTER]);
      const servis = await envoyerCloche(
        { notifications: this.notifications, ws: this.ws },
        AvisPriveNotificationsTemplate.PAS_CONTENT,
        siege,
        {
          nom: p.nom,
          store: p.store,
          extrait: extrait(p.commentaire, EXTRAIT_CLOCHE),
          echeance: p.echeance ? formatJourHeure(p.echeance) : null,
        },
        { kind: 'avis', avis_id: p.avisId },
      );
      if (servis > 0) {
        await this.prisma.avisPriveSuivi.create({
          data: { avis_id: p.avisId, type: AvisSuiviType.SYSTEME, note: TEXTE_ALERTE },
        });
      }
    } catch (erreur) {
      this.logger.error(`Cloche de l'avis ${p.avisId} non envoyée : ${(erreur as Error)?.message ?? erreur}`);
    }
  }
}

/** Le champ piège porte une valeur : un robot a rempli le formulaire. */
export function champPiegeRempli(valeur: unknown): boolean {
  if (valeur === undefined || valeur === null || valeur === false) return false;
  if (typeof valeur === 'string') return valeur.trim() !== '';
  return true;
}
