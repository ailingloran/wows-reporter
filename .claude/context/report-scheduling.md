# Report Scheduling

Key concerns:
1. daily schedules
2. weekly schedules
3. manual triggers
4. timezone assumptions
5. cron reload behavior
6. safe restarts

Rules:
1. do not change timing behavior accidentally
2. document any new schedule or trigger logic
3. keep manual fallback paths available when possible
