import { sendEmailDto } from '../dto/sendEmailDto';

export interface IEmailService {
    sendEmail(dto: sendEmailDto): Promise<void>;
}
