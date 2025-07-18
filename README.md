# Telegram Mini App Bot

A simple Telegram bot that launches a Mini App using Telegraf.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your:
   - `BOT_TOKEN`: Get from [@BotFather](https://t.me/BotFather)
   - `WEB_APP_URL`: Your Mini App URL

3. **Run the bot:**
   
   Development mode:
   ```bash
   npm run dev
   ```
   
   Production build:
   ```bash
   npm run build
   npm start
   ```

## How it works

- Send `/start` to the bot
- Click "Open Mini App" to launch your web app
- The bot can receive data back from your Mini App via the Main Button

## Bot Commands

- `/start` - Shows the Mini App launch button

## Project Structure

```
├── src/
│   └── bot.ts          # Main bot logic
├── dist/               # Compiled JavaScript (after build)
├── .env                # Environment variables
├── package.json        # Dependencies and scripts
└── tsconfig.json       # TypeScript configuration
```
