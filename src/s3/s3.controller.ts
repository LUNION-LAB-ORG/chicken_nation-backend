import { Controller, Post, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { S3Service } from './s3.service';

@Controller('s3')
export class S3Controller {
    constructor(private readonly s3Service: S3Service) { }

    @Post('upload')
    @UseInterceptors(FileInterceptor('file'))
    async upload(@UploadedFile() file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('Aucun fichier fourni');
        }

        const result = await this.s3Service.uploadFile({
            buffer: file.buffer,
            path: 'chicken-nation/test',
            originalname: file.originalname,
            mimetype: file.mimetype
        });

        if (!result) {
            throw new BadRequestException("Erreur lors de l'envoi vers le stockage");
        }

        return result;
    }
}