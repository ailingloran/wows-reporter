# Deployment Runbook

Standard deployment flow:
1. pull latest code on VPS
2. install dependencies if needed
3. build TypeScript output
4. restart PM2 process
5. check logs
6. validate bot startup
7. validate dashboard API
8. validate one manual command or trigger

Watch for:
1. missing env values
2. broken schema copy steps
3. wrong database path
4. Discord permission issues
5. cron timing mistakes
