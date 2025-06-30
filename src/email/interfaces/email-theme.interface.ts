export interface EmailTheme {
    colors: {
        primary: string;
        secondary: string;
        accent: string;
        background: string;
        surface: string;
        text: {
            primary: string;
            secondary: string;
            muted: string;
            inverse: string;
        };
        status: {
            success: string;
            warning: string;
            error: string;
            info: string;
        };
        gradients: {
            primary: string;
            secondary: string;
            accent: string;
        };
    };
    typography: {
        fontFamily: string;
        fontSize: {
            xs: string;
            sm: string;
            base: string;
            lg: string;
            xl: string;
            '2xl': string;
            '3xl': string;
        };
        fontWeight: {
            normal: string;
            medium: string;
            semibold: string;
            bold: string;
        };
        lineHeight: {
            tight: string;
            normal: string;
            relaxed: string;
        };
    };
    spacing: {
        xs: string;
        sm: string;
        md: string;
        lg: string;
        xl: string;
        '2xl': string;
        '3xl': string;
    };
    borderRadius: {
        sm: string;
        md: string;
        lg: string;
        xl: string;
        full: string;
    };
    shadows: {
        sm: string;
        md: string;
        lg: string;
        xl: string;
    };
    animation: {
        duration: {
            fast: string;
            normal: string;
            slow: string;
        };
        easing: {
            default: string;
            bounce: string;
            smooth: string;
        };
    };
}