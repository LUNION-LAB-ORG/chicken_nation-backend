import { urlPublique } from '../../common/utils/url-publique.util';

export const AssetsImages = {
    logo: {
        url: urlPublique('uploads/assets/logo.png'),
    },
    frontend: {
        url: process.env.FRONTEND_URL ?? "https://chicken-nation-dashboard.vercel.app"
    },
    banner: {
        url: urlPublique('uploads/assets/banner.png'),
    }
}
