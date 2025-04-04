import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module'; 
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  // Configuration CORS
  app.enableCors();
  
  // Configuration de la validation globale
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

 
  app.setGlobalPrefix('api');

  // Configuration Swagger
  const config = new DocumentBuilder()
    .setTitle('CHICKEN NATION API')
    .setDescription('Documentation de l\'API De CHICKEN NATION')
    .setVersion('1.0')
    .addTag('auth', 'Authentification et gestion des utilisateurs')
    .addBearerAuth()
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  
  const port = configService.get<number>('PORT') || 3000;
  
  await app.listen(port);
  console.log(`l'Application a démarrée sur le serveur: http://localhost:${port}`);
  console.log(`La documentation Swagger est disponible sur : http://localhost:${port}/api/docs`);
}

bootstrap();