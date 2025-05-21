import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class sendEmailDto {
  @IsNotEmpty()
  @IsEmail({}, { each: true })
  recipients: string | string[];

  @IsString()
  subject: string;

  @IsString()
  html: string;

  @IsOptional()
  @IsString()
  text: string;
}
