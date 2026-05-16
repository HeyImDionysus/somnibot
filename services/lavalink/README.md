# Lavalink

Lavalink v4 music server for SomniBot.

## Setup

1. Copy `application.yml` and configure your YouTube OAuth refresh token
2. Run via Docker Compose from the project root: `docker compose up lavalink`

## YouTube OAuth

To get a refresh token for YouTube:
1. Follow the [Lavalink YouTube plugin guide](https://github.com/lavalink-devs/youtube-source#oauth-integration)
2. Add the refresh token to `application.yml` under `plugins.youtube.oauth.refreshToken`
