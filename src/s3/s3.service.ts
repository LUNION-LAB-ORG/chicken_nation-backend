import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

@Injectable()
export class S3Service {
    private readonly s3Client: S3Client;
    private readonly accessKeyId: string;
    private readonly secretAccessKey: string;
    private readonly region: string;
    private readonly bucketName: string;
    private readonly cloudFrontUrl: string;
    // private readonly s3Endpoint: string;

    constructor(private readonly configService: ConfigService) {
        this.accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? "";
        this.secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? "";
        this.region = this.configService.get<string>('AWS_REGION') ?? "us-east-1";
        this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME') ?? "";
        this.cloudFrontUrl = this.configService.get<string>('AWS_CLOUDFRONT_URL') ?? "";
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

    async getFile(key: string): Promise<Readable> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            const response = await this.s3Client.send(command);

            // Body est un stream
            return response.Body as Readable;
        } catch (error: any) {
            console.error('S3 Get File Error:', error);
            throw error;
        }
    }

    getCdnFileUrl(key: string): string {
        if (!this.cloudFrontUrl) {
            throw new Error('CloudFront URL is not configured');
        }

        const normalizedBaseUrl = this.cloudFrontUrl.replace(/\/$/, '');
        const normalizedKey = key.replace(/^\//, '');

        return `${normalizedBaseUrl}/${normalizedKey}`;
    }

    async deleteFile(key: string): Promise<boolean> {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
            return true;
        } catch (error: any) {
            console.error('S3 Delete Error:', error);
            return false;
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