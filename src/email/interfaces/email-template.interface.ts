
export interface EmailContext<T> {
    recipients: string[];
    data: T;
    meta?: any;
}

export interface EmailTemplate<T> {
    subject: (context: EmailContext<T>) => string;
    content: (context: EmailContext<T>) => string;
}