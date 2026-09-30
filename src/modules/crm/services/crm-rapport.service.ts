import { Injectable } from '@nestjs/common';
import { AnalyticsQueryDto } from '../dto/analytics.dto';
import { CrmAnalyticsService } from './crm-analytics.service';
import { Perimetre } from './crm-passages.query';

/** Un chiffre clé, avec ce qu'il valait sur la période précédente. */
export interface ChiffreCle {
  cle: string;
  libelle: string;
  valeur: number;
  precedent: number;
  /**
   * Variation en pourcentage, ou `null` quand la période précédente était à
   * zéro : une progression calculée depuis zéro est infinie, donc muette.
   * L'écran écrit « nouveau » plutôt qu'un pourcentage qui ne veut rien dire.
   */
  variation: number | null;
  /** Un montant s'affiche en francs, pas comme un décompte. */
  monnaie?: boolean;
}

const JOUR = 86_400_000;
const jour = (d: Date) => d.toISOString().slice(0, 10);

/**
 * RAPPORT D'ACTIVITÉ DU CRM sur une période.
 *
 * Tout était déjà calculé, mais éclaté sur huit points d'entrée : pour se
 * faire une idée il fallait ouvrir huit vues et noter les chiffres. Ce
 * service n'invente aucune requête, il ASSEMBLE les mêmes méthodes que le
 * tableau de bord. C'est délibéré : deux calculs parallèles du même chiffre
 * finissent toujours par diverger, et on passe ensuite des semaines à se
 * demander lequel dit vrai.
 *
 * Il ajoute la seule chose qui manquait vraiment : la COMPARAISON avec la
 * période précédente de même durée. « Savoir si les choses évoluent » ne se
 * lit pas sur un nombre absolu — 87 joints cette semaine ne dit rien tant
 * qu'on ignore que c'était 62 la semaine d'avant.
 */
@Injectable()
export class CrmRapportService {
  constructor(private readonly analytics: CrmAnalyticsService) {}

  /**
   * Bornes de la période et de celle qui la précède immédiatement, de même
   * durée. Sans dates, les sept derniers jours : la lecture hebdomadaire est
   * celle qui répond à « est-ce que ça bouge », le quotidien étant trop
   * bruité et le mensuel trop tardif pour corriger quoi que ce soit.
   */
  private bornes(q: AnalyticsQueryDto) {
    const fin = q.to ? new Date(`${q.to.slice(0, 10)}T00:00:00.000Z`) : new Date(`${jour(new Date())}T00:00:00.000Z`);
    const debut = q.from
      ? new Date(`${q.from.slice(0, 10)}T00:00:00.000Z`)
      : new Date(fin.getTime() - 6 * JOUR);
    const jours = Math.max(1, Math.round((fin.getTime() - debut.getTime()) / JOUR) + 1);
    const finPrecedente = new Date(debut.getTime() - JOUR);
    const debutPrecedent = new Date(finPrecedente.getTime() - (jours - 1) * JOUR);
    return { debut, fin, debutPrecedent, finPrecedente, jours };
  }

  async rapport(q: AnalyticsQueryDto & Perimetre) {
    const { debut, fin, debutPrecedent, finPrecedente, jours } = this.bornes(q);
    const periode = { ...q, from: jour(debut), to: jour(fin) };
    const precedente = { ...q, from: jour(debutPrecedent), to: jour(finPrecedente) };

    const [tendance, tendancePrec, vue, vuePrec, qualite, agents, raisons] = await Promise.all([
      this.analytics.tendance(periode),
      this.analytics.tendance(precedente),
      this.analytics.vueEnsemble(periode),
      this.analytics.vueEnsemble(precedente),
      this.analytics.qualite(periode),
      this.analytics.agents(periode),
      this.analytics.raisons(periode),
    ]);

    const cumul = (serie: { entrees: number; captures: number; appels: number; joints: number; coupons: number; conversions: number }[]) =>
      serie.reduce(
        (a, l) => ({
          entrees: a.entrees + l.entrees,
          captures: a.captures + l.captures,
          appels: a.appels + l.appels,
          joints: a.joints + l.joints,
          coupons: a.coupons + l.coupons,
          conversions: a.conversions + l.conversions,
        }),
        { entrees: 0, captures: 0, appels: 0, joints: 0, coupons: 0, conversions: 0 },
      );

    const a = cumul(tendance.serie);
    const b = cumul(tendancePrec.serie);

    const cle = (cle: string, libelle: string, valeur: number, precedent: number, monnaie = false): ChiffreCle => ({
      cle,
      libelle,
      valeur,
      precedent,
      // Depuis zéro, aucune variation n'est calculable : on le dit par `null`.
      variation: precedent > 0 ? Math.round(((valeur - precedent) / precedent) * 1000) / 10 : null,
      ...(monnaie ? { monnaie: true } : {}),
    });

    const cles: ChiffreCle[] = [
      cle('entrees', 'Entrées au CRM', a.entrees, b.entrees),
      cle('captures', 'Relevés en caisse', a.captures, b.captures),
      cle('appels', 'Appels passés', a.appels, b.appels),
      cle('joints', 'Clients joints', a.joints, b.joints),
      cle('coupons', 'Coupons envoyés', a.coupons, b.coupons),
      cle('conversions', 'Conversions', a.conversions, b.conversions),
      cle('ca', "Chiffre d'affaires", vue.conversion.ca_periode, vuePrec.conversion.ca_periode, true),
      cle('panier_moyen', 'Panier moyen', vue.conversion.panier_moyen, vuePrec.conversion.panier_moyen, true),
    ];

    return {
      periode: { debut: jour(debut), fin: jour(fin), jours },
      precedente: { debut: jour(debutPrecedent), fin: jour(finPrecedente) },
      cles,
      /** Taux lus sur la période, avec leur équivalent précédent. */
      taux: {
        contact: { valeur: pct(a.joints, a.appels), precedent: pct(b.joints, b.appels) },
        conversion: { valeur: pct(a.conversions, a.entrees), precedent: pct(b.conversions, b.entrees) },
        coupon_utilise: { valeur: pct(a.conversions, a.coupons), precedent: pct(b.conversions, b.coupons) },
      },
      serie: tendance.serie,
      population: vue.population,
      entonnoir: vue.entonnoir,
      entonnoirs: vue.entonnoirs,
      passage_appli: vue.passage_appli,
      conversion: vue.conversion,
      qualite,
      agents,
      raisons,
    };
  }
}

/** Pourcentage à une décimale ; `0` plutôt qu'une division par zéro. */
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}
