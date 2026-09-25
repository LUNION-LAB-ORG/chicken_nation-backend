/**
 * Outils d'attente pour la connexion du personnel.
 *
 * FileParCle : les tâches d'une même clé passent une par une, dans l'ordre
 * d'arrivée ; des clés différentes restent indépendantes. Sans elle, des essais
 * de mot de passe lancés en parallèle sur un même email liraient tous le
 * compteur d'échecs avant que le premier échec soit écrit, et passeraient tous
 * le verrou (le cache n'offre pas d'incrément atomique).
 *
 * La file vit dans le processus : elle suffit tant qu'un seul serveur sert
 * l'API. Avec plusieurs serveurs, chacun sérialise ses propres essais.
 */
export class FileParCle {
  private readonly files = new Map<string, Promise<void>>();

  /** Nombre de clés qui ont encore une tâche en cours ou en attente. */
  get taille(): number {
    return this.files.size;
  }

  async executer<T>(cle: string, tache: () => Promise<T>): Promise<T> {
    const precedente = this.files.get(cle) ?? Promise.resolve();
    // L'échec d'une tâche ne bloque jamais la suivante.
    const courante = precedente.then(tache);
    const fin = courante.then(
      () => undefined,
      () => undefined,
    );
    this.files.set(cle, fin);
    try {
      return await courante;
    } finally {
      // Dernière tâche de la clé : on libère l'entrée.
      if (this.files.get(cle) === fin) this.files.delete(cle);
    }
  }
}

/**
 * Rejette si `promesse` n'a pas abouti dans `ms` millisecondes. Sert au cache :
 * pendant une coupure de Redis, le client garde les commandes en attente au
 * lieu d'échouer, et la connexion resterait suspendue.
 */
export function avantDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`délai de ${ms} ms dépassé`)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}
