import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CreerCategorieIncidentDto, ModifierCategorieIncidentDto, ReglagesIncidentDto } from './incident.dto';
import {
  CLE_BON_FAIBLE,
  CLE_BON_HAUTE,
  CLE_BON_MOYENNE,
  CLE_BON_RESTAURANT,
  CLE_BON_VALIDITE,
  MESSAGE_BAREME,
  MESSAGE_CATEGORIE,
  MESSAGE_DELAI,
  MESSAGE_NOM_PRIS,
  MESSAGE_VALIDITE,
  delaiValide,
  montantValide,
  saisirNomCategorie,
  validiteValide,
} from './incident.rules';
import { CategorieIncident, IncidentService } from './incident.service';

const SELECTION = { id: true, nom: true, pole: true, delai_heures: true, actif: true, ordre: true } as const;

/**
 * Réglages des incidents (administrateur) : catégories et barème des bons.
 * Une catégorie ne se supprime pas : elle se désactive, les incidents passés
 * gardent la leur. Une nouvelle catégorie sert tout de suite, sans déploiement.
 */
@Injectable()
export class IncidentReglagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly incidents: IncidentService,
  ) {}

  private async nomLibre(nom: string, saufId?: string): Promise<void> {
    const pris = await this.prisma.incidentCategorie.findFirst({
      where: { nom: { equals: nom, mode: 'insensitive' }, ...(saufId && { id: { not: saufId } }) },
      select: { id: true },
    });
    if (pris) throw new ConflictException(MESSAGE_NOM_PRIS);
  }

  async creerCategorie(dto: CreerCategorieIncidentDto): Promise<CategorieIncident> {
    const nom = saisirNomCategorie(dto.nom);
    if ('refus' in nom) throw new BadRequestException(nom.refus);
    if (!delaiValide(dto.delai_heures)) throw new BadRequestException(MESSAGE_DELAI);
    await this.nomLibre(nom.texte);
    const derniere = await this.prisma.incidentCategorie.findFirst({ orderBy: { ordre: 'desc' }, select: { ordre: true } });
    return this.prisma.incidentCategorie.create({
      data: { nom: nom.texte, pole: dto.pole, delai_heures: dto.delai_heures, ordre: (derniere?.ordre ?? 0) + 1 },
      select: SELECTION,
    });
  }

  async modifierCategorie(id: string, dto: ModifierCategorieIncidentDto): Promise<CategorieIncident> {
    const categorie = await this.prisma.incidentCategorie.findFirst({ where: { id }, select: { id: true } });
    if (!categorie) throw new NotFoundException(MESSAGE_CATEGORIE);
    const data: { nom?: string; pole?: CategorieIncident['pole']; delai_heures?: number; actif?: boolean } = {};
    if (dto.nom !== undefined) {
      const nom = saisirNomCategorie(dto.nom);
      if ('refus' in nom) throw new BadRequestException(nom.refus);
      await this.nomLibre(nom.texte, id);
      data.nom = nom.texte;
    }
    if (dto.delai_heures !== undefined) {
      if (!delaiValide(dto.delai_heures)) throw new BadRequestException(MESSAGE_DELAI);
      data.delai_heures = dto.delai_heures;
    }
    if (dto.pole !== undefined) data.pole = dto.pole;
    if (dto.actif !== undefined) data.actif = dto.actif;
    return this.prisma.incidentCategorie.update({ where: { id }, data, select: SELECTION });
  }

  /** Barème, validité des bons et droit des restaurants à en offrir. */
  async enregistrer(dto: ReglagesIncidentDto) {
    if (dto.bareme) {
      const { FAIBLE, MOYENNE, HAUTE } = dto.bareme;
      if (![FAIBLE, MOYENNE, HAUTE].every(montantValide)) throw new BadRequestException(MESSAGE_BAREME);
    }
    if (dto.validite_jours !== undefined && !validiteValide(dto.validite_jours)) {
      throw new BadRequestException(MESSAGE_VALIDITE);
    }
    if (dto.bareme) {
      await this.settings.set(CLE_BON_FAIBLE, String(dto.bareme.FAIBLE), 'Incidents : bon pour une gravité faible (F)');
      await this.settings.set(CLE_BON_MOYENNE, String(dto.bareme.MOYENNE), 'Incidents : bon pour une gravité moyenne (F)');
      await this.settings.set(CLE_BON_HAUTE, String(dto.bareme.HAUTE), 'Incidents : bon pour une gravité haute (F)');
    }
    if (dto.validite_jours !== undefined) {
      await this.settings.set(CLE_BON_VALIDITE, String(dto.validite_jours), 'Incidents : validité du bon (jours)');
    }
    if (dto.bon_restaurant !== undefined) {
      await this.settings.set(
        CLE_BON_RESTAURANT,
        String(dto.bon_restaurant),
        'Incidents : manager et assistant peuvent offrir un bon',
      );
    }
    return this.incidents.reglagesEtCategories();
  }
}
