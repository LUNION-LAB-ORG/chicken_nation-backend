import { Injectable } from "@nestjs/common";


@Injectable()
export class GenerateDataService {

    /**
 * Generates a secure password that meets the required pattern:
 * - At least 8 characters
 * - At least 1 uppercase letter
 * - At least 1 digit
 * - At least 1 special character
 */
    generateSecurePassword(): string {
        const length = 12;
        const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lowercase = 'abcdefghijklmnopqrstuvwxyz';
        const numbers = '0123456789';
        const specialChars = '@$!%*?&';
        const allChars = uppercase + lowercase + numbers + specialChars;

        // Ensure we have at least one of each required character type
        let password =
            uppercase.charAt(Math.floor(Math.random() * uppercase.length)) +
            lowercase.charAt(Math.floor(Math.random() * lowercase.length)) +
            numbers.charAt(Math.floor(Math.random() * numbers.length)) +
            specialChars.charAt(Math.floor(Math.random() * specialChars.length));

        // Fill the rest with random characters
        for (let i = 4; i < length; i++) {
            password += allChars.charAt(Math.floor(Math.random() * allChars.length));
        }

        // Shuffle the password to make it more random
        return password.split('').sort(() => 0.5 - Math.random()).join('');
    }
}