import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { Setting } from '@prisma/client';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async get(key: string): Promise<string | null> {
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    return setting?.value ?? null;
  }

  /**
   * Récupère une valeur depuis la table Settings.
   * Si absente, tombe sur la variable d'environnement via ConfigService.
   */
  async getOrEnv(settingKey: string, envKey: string, defaultValue?: string): Promise<string | undefined> {
    const dbValue = await this.get(settingKey);
    if (dbValue !== null && dbValue !== '') return dbValue;
    if (defaultValue !== undefined) {
      return this.configService.get<string>(envKey, defaultValue);
    }
    return this.configService.get<string>(envKey);
  }

  /**
   * Variante RÉSILIENTE de getOrEnv : env-first et ne LÈVE JAMAIS.
   *
   * L'env gagne (cas normal → aucune requête DB), sinon on tente la table Settings
   * en avalant toute erreur (ex : Neon injoignable P1001) et on retombe sur la
   * valeur par défaut. À utiliser pour les vérifications qui ne doivent PAS dépendre
   * de la disponibilité de la base (ex : secret de webhook KKiaPay) — un blip Neon
   * ne doit jamais transformer une vérif de secret en 500.
   */
  async getOrEnvSafe(settingKey: string, envKey: string, defaultValue = ''): Promise<string> {
    const envVal = this.configService.get<string>(envKey);
    if (envVal) return envVal;
    try {
      const dbVal = await this.get(settingKey);
      if (dbVal) return dbVal;
    } catch (e) {
      this.logger.warn(
        `getOrEnvSafe(${settingKey}) : DB injoignable, fallback env/défaut : ${(e as any)?.message}`,
      );
    }
    return defaultValue;
  }

  /**
   * Récupère plusieurs clés depuis Settings avec fallback sur .env via ConfigService.
   * @param mapping - Record<settingKey, envKey>
   */
  async getManyOrEnv(mapping: Record<string, string>): Promise<Record<string, string | undefined>> {
    const settingKeys = Object.keys(mapping);
    const dbValues = await this.getMany(settingKeys);
    const result: Record<string, string | undefined> = {};
    for (const [settingKey, envKey] of Object.entries(mapping)) {
      const dbVal = dbValues[settingKey];
      result[settingKey] = (dbVal !== undefined && dbVal !== '')
        ? dbVal
        : this.configService.get<string>(envKey);
    }
    return result;
  }

  async getJson<T = any>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      this.logger.warn(`Setting "${key}" is not valid JSON: ${value}`);
      return null;
    }
  }

  async set(key: string, value: string, description?: string): Promise<Setting> {
    // Un formulaire qui renvoie le MASQUE d'un secret ne doit JAMAIS l'écraser :
    // no-op, on renvoie l'existant (re-masqué pour ne pas fuir en réponse).
    if (
      value !== SettingsService.MASK &&
      value.startsWith(SettingsService.MASK) &&
      SettingsService.isSensitiveKey(key)
    ) {
      // L'utilisateur a TAPÉ à la suite du masque affiché (« ********sk_… ») :
      // enregistrer tel quel casserait la clé silencieusement. Refus explicite.
      throw new BadRequestException(
        'Effacez le masque (« ******** ») avant de saisir la nouvelle valeur.',
      );
    }
    if (value === SettingsService.MASK) {
      const existing = await this.prisma.setting.findUnique({ where: { key } });
      if (existing) return this.maskSetting(existing);
      // Masque soumis sur une clé inexistante : on refuse d'enregistrer la
      // valeur littérale « ******** » comme secret.
      return { key, value: '', description: description ?? null } as Setting;
    }
    const saved = await this.prisma.setting.upsert({
      where: { key },
      update: { value, ...(description !== undefined && { description }) },
      create: { key, value, description },
    });
    // Ne jamais renvoyer un secret fraîchement écrit en clair dans la réponse.
    return this.maskSetting(saved);
  }

  async setJson(key: string, value: any, description?: string): Promise<Setting> {
    return this.set(key, JSON.stringify(value), description);
  }

  async getMany(keys: string[]): Promise<Record<string, string>> {
    const settings = await this.prisma.setting.findMany({
      where: { key: { in: keys } },
    });
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    return result;
  }

  /**
   * FAILLE CORRIGÉE (31/07) : GET /settings renvoyait TOUTES les valeurs en
   * clair — les champs « password » du backoffice ne masquaient qu'à l'écran,
   * les clés privées KKiaPay étaient lisibles dans l'onglet Réseau par tout
   * compte ayant la lecture des Paramètres. Les valeurs sensibles sont
   * désormais masquées CÔTÉ SERVEUR (write-only) : le client ne reçoit que
   * `SettingsService.MASK`, et `set()` ignore une soumission du masque (le
   * formulaire peut renvoyer tous ses champs sans écraser les secrets).
   */
  static readonly MASK = '********';

  /** Une clé est sensible si elle désigne un secret — jamais une clé publique. */
  static isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    if (k.includes('public')) return false;
    return /(private_key|secret_key|webhook_secret|secret|token|password|apikey|api_key)/.test(k);
  }

  private maskSetting(setting: Setting): Setting {
    if (!SettingsService.isSensitiveKey(setting.key) || !setting.value) return setting;
    return { ...setting, value: SettingsService.MASK };
  }

  async getAll(prefix?: string): Promise<Setting[]> {
    const settings = await this.prisma.setting.findMany({
      where: prefix ? { key: { startsWith: prefix } } : undefined,
      orderBy: { key: 'asc' },
    });
    return settings.map((s) => this.maskSetting(s));
  }

  async delete(key: string): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
  }
}
