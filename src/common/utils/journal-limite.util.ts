/**
 * Limiteur de lignes de journal : au plus une ligne par clé et par fenêtre.
 *
 * Sert aux événements qui peuvent se répéter en rafale (connexions refusées,
 * base injoignable pendant une vague de reconnexions, livreur dont le réseau
 * saute) : la première ligne est écrite, les suivantes sont comptées, et le
 * compte est rendu avec la ligne suivante qui passe.
 *
 * Mémoire bornée : au-delà de `maxCles`, les clés dont la fenêtre est passée
 * sont oubliées (toutes, si cela ne suffit pas).
 */
export class JournalLimite {
  private readonly cles = new Map<string, { depuis: number; tues: number }>();

  constructor(
    private readonly fenetreMs: number,
    private readonly maxCles = 1000,
  ) {}

  /**
   * `null` : ligne à taire (déjà écrite dans la fenêtre). Sinon, le nombre de
   * lignes tues pour cette clé depuis la dernière écrite (0 le plus souvent).
   */
  autoriser(cle: string, maintenant = Date.now()): number | null {
    const entree = this.cles.get(cle);
    if (entree && maintenant - entree.depuis < this.fenetreMs) {
      entree.tues += 1;
      return null;
    }
    const tues = entree?.tues ?? 0;
    this.cles.set(cle, { depuis: maintenant, tues: 0 });
    if (this.cles.size > this.maxCles) this.oublier(maintenant);
    return tues;
  }

  private oublier(maintenant: number): void {
    for (const [cle, entree] of this.cles) {
      if (maintenant - entree.depuis >= this.fenetreMs) this.cles.delete(cle);
    }
    if (this.cles.size > this.maxCles) this.cles.clear();
  }
}

/** « (et 3 autres) » après une ligne qui en remplace d'autres, rien sinon. */
export function suffixeTues(tues: number): string {
  if (tues <= 0) return '';
  return tues === 1 ? ' (et 1 autre)' : ` (et ${tues} autres)`;
}
