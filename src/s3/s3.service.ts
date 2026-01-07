import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
    private readonly s3Client: S3Client;
    private readonly accessKeyId: string;
    private readonly secretAccessKey: string;
    private readonly region: string;
    private readonly bucketName: string;
    // private readonly s3Endpoint: string;

    constructor(private readonly configService: ConfigService) {
        this.accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? "";
        this.secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? "";
        this.region = this.configService.get<string>('AWS_REGION') ?? "us-east-1";
        this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME') ?? "";
        // this.s3Endpoint = this.configService.get<string>('AWS_S3_ENDPOINT') ?? "";

        this.s3Client = new S3Client({
            region: this.region,
            credentials: {
                accessKeyId: this.accessKeyId,
                secretAccessKey: this.secretAccessKey,
            },
            // endpoint: this.s3Endpoint || undefined,
            forcePathStyle: true,
        });
    }

    async uploadFile({ buffer, path, originalname, mimetype }: { buffer: Buffer, path: string, originalname: string, mimetype: string }) {
        const name = originalname;

        const fileKey = `${path}/${Date.now()}-${this.formatFileName(name)}`;

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: fileKey,
                Body: buffer,
                ContentType: mimetype,
            });

            await this.s3Client.send(command);

            return {
                key: fileKey,
                url: `${this.bucketName}/${fileKey}`,
            };
        } catch (error: any) {
            console.error('S3 Upload Error:', error);
            return null;
        }
    }

    private formatFileName(originalName: string): string {
        return originalName
            .toLowerCase()
            .trim()
            .replace(/[^\w\s.-]/g, '')
            .replace(/\s+/g, '-');
    }
}