import { Injectable, Logger } from '@nestjs/common';
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
    return this.prisma.setting.upsert({
      where: { key },
      update: { value, ...(description !== undefined && { description }) },
      create: { key, value, description },
    });
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

  async getAll(prefix?: string): Promise<Setting[]> {
    return this.prisma.setting.findMany({
      where: prefix ? { key: { startsWith: prefix } } : undefined,
      orderBy: { key: 'asc' },
    });
  }

  async delete(key: string): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
  }
}
