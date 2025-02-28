import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Liaison du Swagger
  const config = new DocumentBuilder()
    .setTitle('Chicken-nation API')
    .setDescription('The Chicken-nation API description')
    .setVersion('1.0')
    .addTag('chicken-nation')
    .build();

  const documentFactory = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);
  //

  // injecter globalement ValidationPipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  //

  await app.listen(process.env.PORT ?? 8081);
}
bootstrap();
