import { RequestLoggerInterceptor } from './request-logger/request-logger.interceptor';
import { ConsoleLogger, Req, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as compression from 'compression';
import helmet from 'helmet';
import { join } from 'path';
import { PrismaExceptionFilter } from 'src/database/filters/prisma-exception.filter';
import { AppModule } from './app.module';

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({
      timestamp: true,
      logLevels: isProduction
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'debug', 'verbose', 'log'],
      json: isProduction,
      prefix: "chicken_nation_backend",
      colors: !isProduction
    }),
  });

  // injecter globalement ValidationPipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Appliquer le filtre globalement à toute l'application
  app.useGlobalFilters(new PrismaExceptionFilter());

  // Security middleware
  app.use(helmet());

  // Compression
  app.use(compression());

  // CORS
  app.enableCors({
    origin: ['https://chicken-nation-backoffice.vercel.app', 'http://localhost:3000','http://localhost:4006'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Configuration du dossier de téléchargement
  const uploadsPath = join(__dirname, '..', '..', 'uploads');
  console.log('Uploads directory path:', uploadsPath);
  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads'
  });

  app.useGlobalInterceptors(new RequestLoggerInterceptor());

  // Liaison du Swagger
  const config = new DocumentBuilder()
    .setTitle('Chicken-nation API')
    .setDescription('The Chicken-nation API description')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const documentFactory = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, documentFactory);

  // Lancer le serveur
  await app.listen(process.env.PORT ?? 8081);
}
bootstrap();
