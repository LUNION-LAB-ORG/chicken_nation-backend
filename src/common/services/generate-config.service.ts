import { Injectable } from "@nestjs/common";
import { diskStorage } from 'multer';
import { extname } from 'path';
import { GenerateDataService } from "./generate-data.service";

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
}