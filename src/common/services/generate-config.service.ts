import { Injectable } from "@nestjs/common";
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { GenerateDataService } from "./generate-data.service";
import * as sharp from 'sharp';
import * as fs from 'fs';

@Injectable()
export class GenerateConfigService {

    static generateConfigSingleImageUpload(destination: string, name?: string) {
        const imageConfig = {
            storage: diskStorage({
                destination,
                filename: async (req, file, cb) => {
                    const ext = extname(file.originalname);
                    const fileNameHash = await GenerateDataService.generateSecureImageName(name ? req.body[name] : file.originalname);
                    const filename = `${fileNameHash}${ext}`;
                    cb(null, filename);
                },
            }),
            fileFilter: (req, file, cb) => {
                if (!file.originalname.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) {
                    return cb(new Error('Seul les fichiers image sont acceptés'), false);
                }
                cb(null, true);
            },
        };
        return imageConfig;
    }

    static generateConfigMultipleImageUpload(destination: string, name?: string) {
        return {
            storage: diskStorage({
                destination,
                filename: async (req, file, cb) => {
                    const ext = extname(file.originalname);
                    const fileNameHash = await GenerateDataService.generateSecureImageName(name ? req.body[name] : file.originalname);
                    const filename = `${fileNameHash}${ext}`;
                    cb(null, filename);
                },
            }),
            fileFilter: (req, file, cb) => {
                if (!file.originalname.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) {
                    return cb(new Error('Seuls les fichiers image sont acceptés'), false);
                }
                cb(null, true);
            }
        };
    }

    static async compressImages(
        fileMap: Record<string, string>, // <-- entrée modifiée
        outputDir?: string,
        opts: {
            quality?: number;
            width?: number;
            height?: number;
            fit?: 'inside' | 'outside' | 'fill' | 'cover' | 'contain';
        } = {
            quality: 70,
            width: 1280,
            height: 720,
            fit: 'inside',
        },
        deleteOriginal: boolean = false
    ): Promise<Record<string, string>> { // <-- sortie modifiée
        const compressedPaths: Record<string, string> = {};
        const supportedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    if (!fileMap || Object.keys(fileMap).length === 0) return compressedPaths;
        for (const [key, path] of Object.entries(fileMap)) {
            try {
                const ext = extname(path).toLowerCase();
                if (!supportedExts.includes(ext)) continue;
    
                const originalFilename = path.split('/').pop() ?? 'image';
                const [nameWithoutExt] = originalFilename.split(ext);
    
                let finalFilename = originalFilename;
                let tempOutputPath = '';
    
                if (outputDir) {
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
    
                    const samePath = join(outputDir, originalFilename) === path;
    
                    if (!deleteOriginal && samePath) {
                        finalFilename = `compressed_${nameWithoutExt}${ext}`;
                    }
    
                    tempOutputPath = join(outputDir, finalFilename + '.tmp');
                } else {
                    tempOutputPath = path + '.tmp';
                }
    
                const transformer = sharp(path).resize({
                    width: opts.width,
                    height: opts.height,
                    fit: opts.fit,
                });
    
                if (ext === '.jpg' || ext === '.jpeg') {
                    transformer.jpeg({ quality: opts.quality });
                } else if (ext === '.png') {
                    transformer.png({ quality: opts.quality });
                } else if (ext === '.webp') {
                    transformer.webp({ quality: opts.quality });
                }
    
                await transformer.toFile(tempOutputPath);
    
                let finalPath: string;
                if (deleteOriginal) {
                    fs.unlinkSync(path);
                    finalPath = outputDir ? join(outputDir, finalFilename) : path;
                    fs.renameSync(tempOutputPath, finalPath);
                } else {
                    if (!outputDir) {
                        finalPath = tempOutputPath;
                    } else {
                        finalPath = tempOutputPath.replace('.tmp', '');
                        fs.renameSync(tempOutputPath, finalPath);
                    }
                }
    
                compressedPaths[key] = finalPath;
    
            } catch (err) {
                console.error(`Erreur lors de la compression de ${path} :`, err);
            }
        }
    
        return compressedPaths;
    }
    
    

}