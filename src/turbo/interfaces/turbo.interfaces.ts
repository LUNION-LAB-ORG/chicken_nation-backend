

// Interface pour la pagination
export class SortInfo {
    sorted: boolean
    empty: boolean
    unsorted: boolean
}

export class Pageable {
    pageNumber: number
    pageSize: number
    sort: SortInfo
    offset: number
    paged: boolean
    unpaged: boolean
}

