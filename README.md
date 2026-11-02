# Who's the Imposter?

A party game. Everyone gets the same secret word, except one random **imposter**, who only sees the category (or nothing, if the hint is off). Take turns giving clues, then vote on who's faking it.

There are two ways to play:

| | Where | Players |
|---|---|---|
| **Online** | `/` on the Render site | Each person uses their own phone. Share the room link. |
| **Pass-and-play** | `/solo/` on the site, or the Android app | One phone gets passed around. Works offline. |

## Project layout

```
server.js            Online game server (Express + Socket.IO). It deals the roles, so nobody can peek.
public/index.html    Online game page
app/www/             Pass-and-play app (also used as the Android app)
app/www/words.js     Word bank shared by both versions. Add words or categories here.
app/android/         Android project (Capacitor)
render.yaml          Render settings
.github/workflows/   Builds the Android APK on every push
```

## Deploy on Render

1. Go to <https://dashboard.render.com/blueprints>, then **New Blueprint Instance**, and pick this repo.
2. Click **Apply**. Render reads `render.yaml`, installs everything and starts the server.
3. When it's live, open `https://<your-service>.onrender.com`.

On Render's free plan the server sleeps after 15 minutes without visitors. The first visit after that takes about a minute to wake it up.

## Android app

Every push that changes `app/` builds a new APK with GitHub Actions and publishes it to the **android-latest** release:

`https://github.com/djswagmaster/imposter-game/releases/download/android-latest/imposter.apk`

Open that link on an Android phone, download it, and tap it to install. You may need to allow "Install unknown apps" for your browser. Newer builds install over older ones.

## iPhone

Open `https://<your-service>.onrender.com/solo/` in Safari, tap **Share**, then **Add to Home Screen**. It opens full-screen and works offline.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```
