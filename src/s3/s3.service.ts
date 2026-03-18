import { Injectable } from '@nestjs/common';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class S3Service {
    private s3Client: S3Client | null = null;
    private cachedConfig: {
        accessKeyId: string;
        secretAccessKey: string;
        region: string;
        bucketName: string;
        cloudFrontUrl: string;
    } | null = null;

    constructor(private readonly settingsService: SettingsService) {}

    private async getConfig() {
        const config = await this.settingsService.getManyOrEnv({
            aws_access_key_id: 'AWS_ACCESS_KEY_ID',
            aws_secret_access_key: 'AWS_SECRET_ACCESS_KEY',
            aws_region: 'AWS_REGION',
            aws_s3_bucket_name: 'AWS_S3_BUCKET_NAME',
            aws_cloudfront_url: 'AWS_CLOUDFRONT_URL',
        });

        const accessKeyId = config.aws_access_key_id ?? '';
        const secretAccessKey = config.aws_secret_access_key ?? '';
        const region = config.aws_region ?? 'us-east-1';
        const bucketName = config.aws_s3_bucket_name ?? '';
        const cloudFrontUrl = config.aws_cloudfront_url ?? '';

        // Recréer le client si la config a changé
        if (
            !this.s3Client ||
            !this.cachedConfig ||
            this.cachedConfig.accessKeyId !== accessKeyId ||
            this.cachedConfig.secretAccessKey !== secretAccessKey ||
            this.cachedConfig.region !== region
        ) {
            this.s3Client = new S3Client({
                region,
                credentials: { accessKeyId, secretAccessKey },
                forcePathStyle: true,
            });
            this.cachedConfig = { accessKeyId, secretAccessKey, region, bucketName, cloudFrontUrl };
        }

        return { client: this.s3Client, bucketName, cloudFrontUrl };
    }

    async uploadFile({ buffer, path, originalname, mimetype }: { buffer: Buffer, path: string, originalname: string, mimetype: string }) {
        const { client, bucketName } = await this.getConfig();
        const name = originalname;

        const fileKey = `${path}/${Date.now()}-${this.formatFileName(name)}`;

        try {
            const command = new PutObjectCommand({
                Bucket: bucketName,
                Key: fileKey,
                Body: buffer,
                ContentType: mimetype,
            });

            await client.send(command);

            return {
                key: fileKey,
                url: `${bucketName}/${fileKey}`,
            };
        } catch (error: any) {
            console.error('S3 Upload Error:', error);
            return null;
        }
    }

    async getFile(key: string): Promise<Readable> {
        const { client, bucketName } = await this.getConfig();
        try {
            const command = new GetObjectCommand({
                Bucket: bucketName,
                Key: key,
            });

            const response = await client.send(command);

            // Body est un stream
            return response.Body as Readable;
        } catch (error: any) {
            console.error('S3 Get File Error:', error);
            throw error;
        }
    }

    async getCdnFileUrl(key: string): Promise<string> {
        const { cloudFrontUrl } = await this.getConfig();
        if (!cloudFrontUrl) {
            throw new Error('CloudFront URL is not configured');
        }

        const normalizedBaseUrl = cloudFrontUrl.replace(/\/$/, '');
        const normalizedKey = key.replace(/^\//, '');

        return `${normalizedBaseUrl}/${normalizedKey}`;
    }

    async deleteFile(key: string): Promise<boolean> {
        const { client, bucketName } = await this.getConfig();
        try {
            const command = new DeleteObjectCommand({
                Bucket: bucketName,
                Key: key,
            });

            await client.send(command);
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