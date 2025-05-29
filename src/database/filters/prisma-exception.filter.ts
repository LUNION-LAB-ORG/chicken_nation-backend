import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpStatus,
} from '@nestjs/common';
import {
    PrismaClientKnownRequestError,
    PrismaClientUnknownRequestError,
    PrismaClientValidationError,
    PrismaClientInitializationError,
    PrismaClientRustPanicError
} from '@prisma/client/runtime/library';
import { Response } from 'express';

@Catch(
    PrismaClientKnownRequestError,
    PrismaClientUnknownRequestError,
    PrismaClientValidationError,
    PrismaClientInitializationError,
    PrismaClientRustPanicError
)
export class PrismaExceptionFilter implements ExceptionFilter {
    catch(exception: any, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();

        console.error('Erreur Prisma:', exception.constructor.name, exception.message);

        let status: HttpStatus;
        let message: string;

        // Gestion selon le type d'erreur Prisma
        if (exception instanceof PrismaClientValidationError) {
            status = HttpStatus.BAD_REQUEST;
            message = 'Données de requête invalides - Vérifiez les types et champs requis';
        } else if (exception instanceof PrismaClientInitializationError) {
            status = HttpStatus.SERVICE_UNAVAILABLE;
            message = 'Service de base de données temporairement indisponible';
        } else if (exception instanceof PrismaClientRustPanicError) {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
            message = 'Erreur critique du moteur de base de données - Redémarrage requis';
        } else if (exception instanceof PrismaClientUnknownRequestError) {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
            message = 'Erreur de base de données non identifiée';
        } else if (exception instanceof PrismaClientKnownRequestError) {
            // Gestion des erreurs connues avec codes spécifiques
            ({ status, message } = this.handleKnownRequestError(exception));
        } else {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
            message = 'Erreur de base de données inconnue';
        }

        response.status(status).json({
            statusCode: status,
            message,
            error: this.getErrorName(status),
            timestamp: new Date().toISOString(),
            code: exception.code || 'UNKNOWN',
            details: this.getErrorDetails(exception),
        });
    }

    private handleKnownRequestError(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        const code = exception.code;

        // Erreurs communes P1xxx
        if (code.startsWith('P1')) {
            return this.handleConnectionErrors(exception);
        }

        // Erreurs Client P2xxx
        if (code.startsWith('P2')) {
            return this.handleClientErrors(exception);
        }

        // Erreurs Migrate P3xxx
        if (code.startsWith('P3')) {
            return this.handleMigrateErrors(exception);
        }

        // Erreurs Introspection P4xxx
        if (code.startsWith('P4')) {
            return this.handleIntrospectionErrors(exception);
        }

        // Erreurs Accelerate P6xxx et P5011
        if (code.startsWith('P6') || code === 'P5011') {
            return this.handleAccelerateErrors(exception);
        }

        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Erreur de base de données non gérée'
        };
    }

    private handleConnectionErrors(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        switch (exception.code) {
            case 'P1000':
                return { status: HttpStatus.UNAUTHORIZED, message: 'Identifiants de base de données invalides' };
            case 'P1001':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Impossible de joindre le serveur de base de données' };
            case 'P1002':
                return { status: HttpStatus.REQUEST_TIMEOUT, message: 'Timeout de connexion à la base de données' };
            case 'P1003':
                return { status: HttpStatus.NOT_FOUND, message: 'Base de données introuvable' };
            case 'P1008':
                return { status: HttpStatus.REQUEST_TIMEOUT, message: 'Timeout d\'opération' };
            case 'P1009':
                return { status: HttpStatus.CONFLICT, message: 'Base de données existe déjà' };
            case 'P1010':
                return { status: HttpStatus.FORBIDDEN, message: 'Accès refusé à la base de données' };
            case 'P1011':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Erreur de connexion TLS' };
            case 'P1012':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur de schéma Prisma' };
            case 'P1013':
                return { status: HttpStatus.BAD_REQUEST, message: 'Chaîne de connexion invalide' };
            case 'P1014':
                return { status: HttpStatus.NOT_FOUND, message: 'Modèle de base de données introuvable' };
            case 'P1015':
                return { status: HttpStatus.BAD_REQUEST, message: 'Version de base de données non supportée' };
            case 'P1016':
                return { status: HttpStatus.BAD_REQUEST, message: 'Nombre de paramètres incorrect dans la requête' };
            case 'P1017':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Connexion fermée par le serveur' };
            default:
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Erreur de connexion à la base de données' };
        }
    }

    private handleClientErrors(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        switch (exception.code) {
            case 'P2000':
                return { status: HttpStatus.BAD_REQUEST, message: 'Valeur trop longue pour le champ' };
            case 'P2001':
                return { status: HttpStatus.NOT_FOUND, message: 'Enregistrement introuvable' };
            case 'P2002':
                return { status: HttpStatus.CONFLICT, message: this.getUniqueConstraintMessage(exception) };
            case 'P2003':
                return { status: HttpStatus.BAD_REQUEST, message: 'Référence invalide - L\'élément lié n\'existe pas' };
            case 'P2004':
                return { status: HttpStatus.BAD_REQUEST, message: 'Contrainte de base de données violée' };
            case 'P2005':
                return { status: HttpStatus.BAD_REQUEST, message: 'Valeur invalide pour le type de champ' };
            case 'P2006':
                return { status: HttpStatus.BAD_REQUEST, message: 'Valeur fournie invalide' };
            case 'P2007':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur de validation des données' };
            case 'P2008':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur d\'analyse de la requête' };
            case 'P2009':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur de validation de la requête' };
            case 'P2010':
                return { status: HttpStatus.BAD_REQUEST, message: 'Échec de la requête brute' };
            case 'P2011':
                return { status: HttpStatus.BAD_REQUEST, message: 'Contrainte null violée - Champ requis manquant' };
            case 'P2012':
                return { status: HttpStatus.BAD_REQUEST, message: 'Valeur requise manquante' };
            case 'P2013':
                return { status: HttpStatus.BAD_REQUEST, message: 'Argument requis manquant' };
            case 'P2014':
                return { status: HttpStatus.BAD_REQUEST, message: 'Relation requise violée' };
            case 'P2015':
                return { status: HttpStatus.NOT_FOUND, message: 'Enregistrement lié introuvable' };
            case 'P2016':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur d\'interprétation de la requête' };
            case 'P2017':
                return { status: HttpStatus.BAD_REQUEST, message: 'Enregistrements de relation non connectés' };
            case 'P2018':
                return { status: HttpStatus.NOT_FOUND, message: 'Enregistrements connectés requis introuvables' };
            case 'P2019':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur d\'entrée' };
            case 'P2020':
                return { status: HttpStatus.BAD_REQUEST, message: 'Valeur hors limites pour le type' };
            case 'P2021':
                return { status: HttpStatus.NOT_FOUND, message: 'Table inexistante' };
            case 'P2022':
                return { status: HttpStatus.NOT_FOUND, message: 'Colonne inexistante' };
            case 'P2023':
                return { status: HttpStatus.BAD_REQUEST, message: 'Données de colonne incohérentes' };
            case 'P2024':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Timeout du pool de connexions' };
            case 'P2025':
                return { status: HttpStatus.NOT_FOUND, message: 'Enregistrement requis introuvable pour l\'opération' };
            case 'P2026':
                return { status: HttpStatus.BAD_REQUEST, message: 'Fonctionnalité non supportée par le fournisseur' };
            case 'P2027':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreurs multiples lors de l\'exécution' };
            case 'P2028':
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur d\'API de transaction' };
            case 'P2029':
                return { status: HttpStatus.BAD_REQUEST, message: 'Limite de paramètres de requête dépassée' };
            case 'P2030':
                return { status: HttpStatus.BAD_REQUEST, message: 'Index de recherche textuelle manquant' };
            case 'P2031':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'MongoDB doit fonctionner en replica set' };
            case 'P2033':
                return { status: HttpStatus.BAD_REQUEST, message: 'Nombre trop grand - Utilisez BigInt' };
            case 'P2034':
                return { status: HttpStatus.CONFLICT, message: 'Conflit de transaction ou deadlock - Réessayez' };
            case 'P2035':
                return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Violation d\'assertion sur la base de données' };
            case 'P2036':
                return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Erreur du connecteur externe' };
            case 'P2037':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Trop de connexions ouvertes' };
            default:
                return { status: HttpStatus.BAD_REQUEST, message: 'Erreur de requête de base de données' };
        }
    }

    private handleMigrateErrors(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        // Les erreurs de migration sont généralement des erreurs de développement/déploiement
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Erreur de migration de base de données' };
    }

    private handleIntrospectionErrors(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        // Les erreurs d'introspection sont généralement des erreurs de développement
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Erreur d\'introspection de base de données' };
    }

    private handleAccelerateErrors(exception: PrismaClientKnownRequestError): { status: HttpStatus; message: string } {
        switch (exception.code) {
            case 'P5011':
                return { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Trop de requêtes - Réessayez plus tard' };
            case 'P6001':
                return { status: HttpStatus.BAD_REQUEST, message: 'URL de source de données malformée' };
            case 'P6002':
                return { status: HttpStatus.UNAUTHORIZED, message: 'Clé API invalide' };
            case 'P6003':
                return { status: HttpStatus.PAYMENT_REQUIRED, message: 'Limite du plan dépassée' };
            case 'P6004':
                return { status: HttpStatus.REQUEST_TIMEOUT, message: 'Timeout global d\'Accelerate dépassé' };
            case 'P6005':
                return { status: HttpStatus.BAD_REQUEST, message: 'Paramètres invalides fournis' };
            case 'P6006':
                return { status: HttpStatus.BAD_REQUEST, message: 'Version Prisma non compatible avec Accelerate' };
            case 'P6008':
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Échec du démarrage du moteur' };
            case 'P6009':
                return { status: HttpStatus.PAYLOAD_TOO_LARGE, message: 'Limite de taille de réponse dépassée' };
            case 'P6010':
                return { status: HttpStatus.FORBIDDEN, message: 'Projet Accelerate désactivé' };
            default:
                return { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Erreur Prisma Accelerate' };
        }
    }

    private getUniqueConstraintMessage(exception: PrismaClientKnownRequestError): string {
        const target = exception.meta?.target as string[];
        if (target && target.length > 0) {
            const field = target[0];
            return `${field} existe déjà - Valeur dupliquée`;
        }
        return 'Contrainte unique violée - Cette valeur existe déjà';
    }

    private getErrorDetails(exception: any): any {
        if (exception instanceof PrismaClientKnownRequestError) {
            return {
                code: exception.code,
                meta: exception.meta,
                clientVersion: exception.clientVersion,
            };
        }
        return {
            clientVersion: exception.clientVersion || 'unknown',
        };
    }

    private getErrorName(status: HttpStatus): string {
        const statusNames: Record<number, string> = {
            [HttpStatus.BAD_REQUEST]: 'Bad Request',
            [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
            [HttpStatus.FORBIDDEN]: 'Forbidden',
            [HttpStatus.NOT_FOUND]: 'Not Found',
            [HttpStatus.CONFLICT]: 'Conflict',
            [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
            [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
            [HttpStatus.REQUEST_TIMEOUT]: 'Request Timeout',
            [HttpStatus.PAYMENT_REQUIRED]: 'Payment Required',
            [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
            [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
        };

        return statusNames[status] || 'Unknown Error';
    }
}