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
     * Génère un numéro de commande unique
     * @returns Un numéro de commande au format ORD-YYMMDD-XXXXX
     */
    generateOrderReference(): string {
        const date = new Date();
        const year = date.getFullYear().toString().slice(-2);
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const random = Math.floor(10000 + Math.random() * 90000);

        return `ORD-${year}${month}${day}-${random}`;
    }

    /**
     * Génère un mot de passe sécurisé qui correspond au pattern requis:
     * - Au moins 8 caractères
     * - Au moins 1 lettre majuscule
     * - Au moins 1 chiffre
     * - Au moins 1 caractère spécial
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

    /**
     * Convertir degrés en radians
     * @param degrees - L'angle en degrés
     * @returns L'angle en radians
     */
    toRadians(degrees: number): number {
        return degrees * (Math.PI / 180)
    }

    /**
     * Calculer la distance entre deux points géographiques (en km)
     * @param lat1 - Latitude du premier point
     * @param lon1 - Longitude du premier point
     * @param lat2 - Latitude du second point
     * @param lon2 - Longitude du second point
     * @returns La distance entre les deux points en kilomètres
     */
    haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371 // Rayon de la Terre en kilomètres
        const dLat = this.toRadians(lat2 - lat1)
        const dLon = this.toRadians(lon2 - lon1)

        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
            Math.sin(dLon / 2) ** 2

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

        return R * c
    }
}