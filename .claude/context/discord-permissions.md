# Discord Permissions

Be careful when changing anything related to:
1. privileged intents
2. read access
3. message content access
4. slash command permissions
5. role based restrictions
6. channel delivery targets

Rules:
1. keep permission assumptions explicit in code and docs
2. do not assume admin permissions in every environment
3. call out new permission requirements in summaries
