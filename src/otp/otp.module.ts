import { Module } from "@nestjs/common";
import { OtpService } from "./otp.service";
import { DatabaseModule } from "src/database/database.module";

@Module({
  imports: [DatabaseModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule { }
