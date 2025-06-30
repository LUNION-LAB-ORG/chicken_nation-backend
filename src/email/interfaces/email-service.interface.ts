import { sendEmailDto } from '../dto/sendEmailDto';
import { EmailContext, EmailTemplate } from './email-template.interface';

export interface IEmailService {
    sendEmail(dto: sendEmailDto): Promise<void>;
    sendEmailTemplate<T>(template: EmailTemplate<T>, context: EmailContext<T>): Promise<void>;
}
