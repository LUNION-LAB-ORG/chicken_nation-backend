import { join } from "path";

export const AssetsImages = {
    logo: {
        url: join(process.env.BASE_URL ?? "", 'uploads/assets/logo.png'),
    },
    frontend: {
        url: process.env.FRONTEND_URL ?? "https://chicken-nation-dashboard.vercel.app"
    },
    banner: {
        url: join(process.env.BASE_URL ?? "", 'uploads/assets/banner.png'),
    }
}
