import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

export const getDatabaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => {
  const isProduction = configService.get('NODE_ENV') === 'production';

  return {
    type: 'postgres',
    url: configService.get('DATABASE_URL'),
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: !isProduction,
    migrationsRun: false,
    ssl: isProduction
      ? {
          rejectUnauthorized: false,
        }
      : false,
    extra: {
      max: isProduction ? 1 : 5,
      application_name: 'chicken-backend',
      nativeDriver: false,
      options: '-c statement_timeout=10000',
      poolSize: isProduction ? 1 : 5,
      idleTimeoutMillis: isProduction ? 10000 : 30000,
    },
    logging: !isProduction ? ['error', 'warn'] : false,
    connectTimeoutMS: 10000,
  };
};
