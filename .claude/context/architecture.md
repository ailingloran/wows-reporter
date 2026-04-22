# Architecture

Main layers:
1. Discord integration
2. scheduled reporting
3. message indexing
4. SQLite persistence
5. dashboard API
6. AI assisted pulse analysis

Key principles:
1. scheduler triggers jobs
2. jobs collect and transform data
3. storage keeps durable operational state
4. Discord and dashboard expose results
5. runtime settings should stay easy to update
