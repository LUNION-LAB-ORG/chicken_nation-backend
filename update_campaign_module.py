import re

with open('src/modules/campaign/campaign.module.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "import { CampaignController } from './controllers/campaign.controller';",
    "import { CampaignController } from './controllers/campaign.controller';\nimport { CampaignProspectController } from './controllers/campaign-prospect.controller';"
)

content = content.replace(
    "controllers: [CampaignController],",
    "controllers: [CampaignController, CampaignProspectController],"
)

with open('src/modules/campaign/campaign.module.ts', 'w') as f:
    f.write(content)
