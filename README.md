# Flight Deck

A "start of day" desktop dashboard for developers. One window shows your sprint
tasks, open pull requests, today's meetings, an AI brief of your unread mail,
Claude usage limits and AI news, and it sends native reminders before meetings.

Built with Tauri 2 (Rust) + React 19 + TypeScript + Vite + Tailwind. Linux is
the main target (tested on GNOME).

## Features

- **Overview**: Claude weekly / 5-hour usage, stat tiles, next meeting with a
  countdown, an AI mail brief, today's schedule, ClickUp tasks (with a status
  picker), a local todo list and AI headlines.
- **Pull Requests**: Bitbucket PRs and GitLab merge requests you authored or
  need to review, in one list.
- **AI News**: a feed of AI blogs and news sites.
- **Meeting reminders**: native notifications a configurable number of minutes
  before each meeting, with a Join button.
- **Mail notifications**: new unread Outlook mail shows up as a notification.
- **Keyboard**: `Ctrl+K` command palette, `Ctrl+,` settings,
  `Ctrl+Shift+Space` show/hide the window, `Ctrl+Q` quit.

Every integration is optional. Link the ones you use in Settings (gear icon).

## Requirements

- Linux with a desktop session (GNOME recommended), X11 or XWayland
- A Secret Service keyring (gnome-keyring or KWallet) for storing tokens
- A notification daemon (any modern desktop has one)

To build from source you also need:

- Node.js 20 (see `.nvmrc`)
- Rust (stable, via [rustup](https://rustup.rs))
- Tauri's Linux system packages. On Debian/Ubuntu:

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  For other distros, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Install

```bash
git clone https://github.com/IrakliSlivin/flight-deck.git
cd flight-deck
npm install
npx tauri build --no-bundle
./scripts/install-desktop.sh
```

This installs `~/.local/bin/flight-deck` and a "Flight Deck" entry in your app
menu (no sudo). To update, `git pull` and run the last two commands again.

If you'd rather have a package, `npm run tauri build` produces `.deb`, `.rpm`
and `.AppImage` files in `src-tauri/target/release/bundle/`.

## Setting up integrations

Open Settings (gear icon or `Ctrl+,`). Tokens are saved in your OS keyring,
never in a file, and every request goes straight from your machine to the
service.

| Integration | What you need |
|---|---|
| **ClickUp** | A personal API token (ClickUp → Settings → Apps → API Token). Optionally a Space, Folder or List URL to narrow the tasks. |
| **Bitbucket** | An [Atlassian API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens): choose **"Create API token with scopes"**, pick the **Bitbucket** app, and check `read:pullrequest:bitbucket`, `read:user:bitbucket` and `read:repository:bitbucket`. Also your Atlassian email and workspace slug(s). |
| **GitLab** | A [personal access token](https://gitlab.com/-/user_settings/personal_access_tokens) with the `read_api` scope. Set the GitLab URL if it's self-hosted. |
| **Outlook Calendar** | A published ICS link: Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar → "Can view all details" → copy the **ICS** link. |

The Settings drawer shows these steps next to each integration.

### Optional extras

- **Outlook mail** (notifications and the mail brief): there is no API setup.
  The app opens Outlook on the web in a hidden window. Click **Open Outlook**
  on the Mail brief card, sign in once and leave it on the Inbox (`Ctrl+W`
  hides it again). It reads your inbox page, so a
  big change to Outlook's web markup can break it.
- **AI mail brief**: needs [Claude Code](https://claude.com/claude-code)
  installed and logged in (`claude` on your PATH or in `~/.local/bin`). The
  unread messages are sent to Claude using your own Claude Code login.
- **Claude usage tile**: reads Claude Code's local data in `~/.claude`. It
  shows nothing if you don't use Claude Code.

## Privacy

- Tokens and the calendar link are stored in your OS keyring.
- Todos and settings are stored locally (SQLite and JSON in the app data
  folder).
- Nothing is sent to any server run by this project. Data only goes to the
  services you link (ClickUp, Bitbucket, GitLab, Outlook) and, for the mail
  brief, to Claude through your own Claude Code account.

## Development

```bash
npm install
npm run dev:app      # tauri dev with file polling (recommended)
npm run build        # type-check + build the frontend
```

`dev:app` makes Vite poll for file changes instead of using inotify, which
avoids `ENOSPC` crashes on machines with a low inotify watch limit. Plain
`npm run tauri dev` works too.

All network calls happen in Rust (`src-tauri/src`, one module per
integration). The React app calls them through small wrappers in `src/lib`.
New Tauri commands must be added to `src-tauri/build.rs` and
`src-tauri/capabilities/default.json`.

## License

[MIT](LICENSE)
