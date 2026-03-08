import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  // Statbot
  statbotApiKey:   requireEnv('STATBOT_API_KEY'),
  statbotGuildId:  requireEnv('STATBOT_GUILD_ID'),

  // Discord
  discordBotToken:        requireEnv('DISCORD_BOT_TOKEN'),
  discordStaffChannelId:  requireEnv('DISCORD_STAFF_CHANNEL_ID'),
  discordMonthlyChannelId: requireEnv('DISCORD_MONTHLY_CHANNEL_ID'),
  discordPlayerRoleId:    requireEnv('DISCORD_PLAYER_ROLE_ID'),
  discordStaffRoleIds:    (process.env.DISCORD_STAFF_ROLE_IDS  || '').split(',').filter(Boolean),
  discordAdminRoleIds:    (process.env.DISCORD_ADMIN_ROLE_IDS  || '').split(',').filter(Boolean),

  // Scheduling
  dailyCron:     process.env.DAILY_CRON     || '0 0 * * *',
  monthlyCron:   process.env.MONTHLY_CRON   || '0 0 1 * *',
  sentimentCron: process.env.SENTIMENT_CRON || '0 17 * * *',

  // Delivery
  dailyDelivery:   (process.env.DAILY_DELIVERY   || 'discord') as 'discord' | 'dashboard' | 'both',
  monthlyDelivery: (process.env.MONTHLY_DELIVERY || 'both')    as 'discord' | 'dashboard' | 'both',
  monthlyApprovalMode: process.env.MONTHLY_APPROVAL_MODE !== 'false',

  // Dashboard
  dashboardPort:   parseInt(process.env.DASHBOARD_PORT   || '3000', 10),
  dashboardSecret: process.env.DASHBOARD_SECRET || 'changeme',

  // Report window
  dailyWindow: (process.env.DAILY_WINDOW || 'calendarDay') as 'calendarDay' | 'rolling24h',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Community Pulse (OpenAI sentiment analysis)
  openAiApiKey:        process.env.OPENAI_API_KEY || '',
  sentimentChannelIds:   (process.env.SENTIMENT_CHANNEL_IDS || '').split(',').filter(Boolean),
  sentimentMessageLimit: parseInt(process.env.SENTIMENT_MESSAGE_LIMIT || '150', 10),

  // Message index (Hetzner volume)
  messageDbPath:          process.env.MESSAGE_DB_PATH || '/mnt/HC_Volume_105012469/messages.db',
  minIndexMessageLength:  parseInt(process.env.MIN_INDEX_MESSAGE_LENGTH || '30', 10),
  minIndexWordCount:      parseInt(process.env.MIN_INDEX_WORD_COUNT     || '6',  10),
};

// ── Keyword Buckets ───────────────────────────────────────────────────────────
// Edit these arrays to customise which keywords map to each topic bucket.
// Used in the monthly report's keyword-themes section.
export const KEYWORD_BUCKETS: Record<string, string[]> = {
  'CV Spotting':   ['cv', 'carrier', 'spotting', 'planes', 'air'],
  'Submarines':    ['sub', 'submarine', 'depth charge', 'sonar', 'torpedo'],
  'Economy':       ['credits', 'economy', 'coal', 'steel', 'research', 'fxp'],
  'Matchmaking':   ['mm', 'matchmaking', 'tier', 'balance', 'teams'],
  'Dockyard':      ['dockyard', 'shipyard', 'puerto rico', 'construction'],
  'Containers':    ['container', 'supercontainer', 'drop', 'loot'],
  'Bugs & Issues': ['bug', 'crash', 'lag', 'fps', 'disconnect', 'error'],
};
