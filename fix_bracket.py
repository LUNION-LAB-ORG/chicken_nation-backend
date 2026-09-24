import re

with open('src/modules/campaign/services/campaign.service.ts', 'r') as f:
    content = f.read()

# Count opening and closing brackets
open_brackets = content.count('{')
close_brackets = content.count('}')

print(f"Open brackets: {open_brackets}")
print(f"Close brackets: {close_brackets}")

# Fix brackets
if close_brackets > open_brackets:
    # Remove the last closing bracket
    content = content.rsplit('}', 1)[0]
    with open('src/modules/campaign/services/campaign.service.ts', 'w') as f:
        f.write(content)
        print("Removed extra closing bracket")

