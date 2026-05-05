import { PartialType } from '@nestjs/swagger';
import { CreateOneSignalTemplateDto } from './create-template.dto';

export class UpdateOneSignalTemplateDto extends PartialType(CreateOneSignalTemplateDto) {}
