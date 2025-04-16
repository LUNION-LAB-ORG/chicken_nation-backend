import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

@Injectable()
export class GenerateDataService {
    // Utilisez un mot de passe fort, mais gardez-le sécurisé et hors du code en production
    static password: string = "Chicken-Nation@2025";

    static async generateCipher(text: string): Promise<string> {
        // Générer une IV - exactement 16 octets pour AES-256-CBC
        const iv = randomBytes(16);

        // Dériver une clé à partir du mot de passe
        const key = (await promisify(scrypt)(GenerateDataService.password, 'salt', 32)) as Buffer;

        // Créer un cipher avec l'IV généré
        const cipher = createCipheriv('aes-256-cbc', key, iv);

        // Encrypter le texte
        const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);

        // Retourner IV + données chiffrées en chaîne hexadécimale
        // IV est préfixé pour pouvoir être extrait lors de la déchiffrement
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }

    static async generateDecipher(encryptedData: string): Promise<string> {
        // Séparer la chaîne pour obtenir l'IV et le texte chiffré
        const [ivHex, encryptedText] = encryptedData.split(':');

        // Convertir l'IV en Buffer
        const iv = Buffer.from(ivHex, 'hex');

        // Dériver la même clé
        const key = (await promisify(scrypt)(GenerateDataService.password, 'salt', 32)) as Buffer;

        // Créer un decipher
        const decipher = createDecipheriv('aes-256-cbc', key, iv);

        // Décrypter les données
        const decrypted = Buffer.concat([decipher.update(encryptedText, 'hex'), decipher.final()]);

        return decrypted.toString('utf8');
    }

    static async generateSecureImageName(name: string): Promise<string> {
        return GenerateDataService.generateCipher(name);
    }

    static async decryptSecureImageName(hash: string): Promise<string> {
        return GenerateDataService.generateDecipher(hash);
    }

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