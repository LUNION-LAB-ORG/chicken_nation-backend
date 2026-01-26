import { Pageable, SortInfo } from "../interfaces/turbo.interfaces";
import { ApiProperty } from '@nestjs/swagger';

// Interface pour les frais de livraison
export class IFraisLivraison {
    @ApiProperty({
        description: "ID unique du frais de livraison",
        example: "a1b2c3d4e5f6g7h8i9j0",
    })
    id: string;

    @ApiProperty({
        description: "Date et heure de création de l'entrée",
        example: "2023-10-27T10:00:00.000Z",
    })
    createdAt: string;

    @ApiProperty({
        description: "Date et heure de la dernière mise à jour",
        example: "2023-10-27T11:30:00.000Z",
    })
    updatedAt: string;

    @ApiProperty({
        description: "Zone géographique de livraison",
        example: "Zone A",
    })
    zone: string;

    @ApiProperty({
        description: "Nom du frais de livraison",
        example: "Frais de livraison standard",
    })
    name: string;

    @ApiProperty({
        description: "Latitude du point central de la zone de livraison",
        example: 48.8566,
    })
    latitude: number;

    @ApiProperty({
        description: "Longitude du point central de la zone de livraison",
        example: 2.3522,
    })
    longitude: number;

    @ApiProperty({
        description: "Distance minimale pour appliquer ce frais",
        example: 0,
    })
    distanceDebut: number;

    @ApiProperty({
        description: "Distance maximale pour appliquer ce frais",
        example: 5,
    })
    distanceFin: number;

    @ApiProperty({
        description: "Prix de la livraison",
        example: 5.50,
    })
    prix: number;

    @ApiProperty({
        description: "Commission sur la livraison",
        example: 1.25,
    })
    commission: number;
}

// Interface pour la réponse de la liste des frais de livraison paginée
export class IFraisLivraisonResponsePaginate {
    @ApiProperty({
        description: "Liste des frais de livraison sur la page actuelle",
        type: [IFraisLivraison],
    })
    content: IFraisLivraison[];

    @ApiProperty({
        description: "Informations de pagination",
        type: () => Pageable,
    })
    pageable: Pageable;

    @ApiProperty({
        description: "Nombre total d'éléments (frais de livraison)",
        example: 100,
    })
    totalElements: number;

    @ApiProperty({
        description: "Nombre total de pages",
        example: 10,
    })
    totalPages: number;

    @ApiProperty({
        description: "Indique si c'est la dernière page",
        example: false,
    })
    last: boolean;

    @ApiProperty({
        description: "Taille de la page",
        example: 10,
    })
    size: number;

    @ApiProperty({
        description: "Numéro de la page actuelle (commence à 0)",
        example: 0,
    })
    number: number;

    @ApiProperty({
        description: "Informations de tri",
        type: () => SortInfo,
    })
    sort: SortInfo;

    @ApiProperty({
        description: "Nombre d'éléments sur la page actuelle",
        example: 10,
    })
    numberOfElements: number;

    @ApiProperty({
        description: "Indique si c'est la première page",
        example: true,
    })
    first: boolean;

    @ApiProperty({
        description: "Indique si la page est vide",
        example: false,
    })
    empty: boolean;
}