import re

with open('src/modules/campaign/controllers/campaign-prospect.controller.ts', 'r') as f:
    content = f.read()

# Replace CurrentUser decorator with Req decorator since CurrentUser doesn't exist
content = content.replace("import { CurrentUser } from 'src/modules/auth/decorators/current-user.decorator';", "import { Req } from '@nestjs/common';")
content = content.replace("@CurrentUser() user: any", "@Req() req: any")
content = content.replace("user.id", "req.user.id")

with open('src/modules/campaign/controllers/campaign-prospect.controller.ts', 'w') as f:
    f.write(content)
