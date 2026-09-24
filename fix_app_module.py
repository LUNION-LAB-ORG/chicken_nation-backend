import re

with open('src/app.module.ts', 'r') as f:
    content = f.read()

# Make sure CampaignModule is imported at the top
if "import { CampaignModule } from './modules/campaign/campaign.module';" not in content:
    content = content.replace(
        "import { PushCampaignModule } from 'src/modules/push-campaign/push-campaign.module';",
        "import { PushCampaignModule } from 'src/modules/push-campaign/push-campaign.module';\nimport { CampaignModule } from './modules/campaign/campaign.module';"
    )

with open('src/app.module.ts', 'w') as f:
    f.write(content)
