# Security Policy

## Threat model

OTO (OBS TCG Overlay) is designed to run on a streamer's own machine and be controlled from devices on the same trusted network. It is **not** built to be exposed to the internet.

- By default the server listens on all network interfaces (`HOST=0.0.0.0`) so a tablet or phone can open the control panel.
- **Control panel password (optional).** When one is set (in the app, or with `OTO_PASSWORD`), every control page, API call and control socket needs a signed-in session. Passwords are stored as a salted scrypt hash, sessions are signed cookies bound to the current password (changing it signs everyone out), and repeated wrong guesses from one address are slowed down. The overlay for OBS never needs the password: it can only receive the game state, never send actions.
- **No password set:** anyone who can reach the port can change the overlay, read and import the configuration, install designs and packages, and clear the card cache. Set a password on any network you do not fully trust.
- **The host.** The person on the computer that runs OTO (a connection from that computer itself, not from the network) is the host. Only the host can rename other producers and remove them (a removed producer is refused for an hour, or until the host lets them back in), and the password can be set, changed and removed from the tray icon, in a small window of the desktop app that can do nothing else.
- **Other websites cannot drive your overlay.** Requests that change something, and socket connections, are refused when the browser says they come from a different site. There is no CORS: the overlay and the control panel are served by the same server they talk to.
- If you are on a network you do not trust (a venue, a hotel, a shared office) and do not need other devices, bind to localhost only:

  ```bash
  HOST=127.0.0.1 npm start
  ```

  and never forward the port to the internet.
- **Forgotten password.** Starting OTO once with `OTO_RESET_PASSWORD=1` removes the stored password. Whoever can start the program on the computer can already read its files, so this is not a way in for someone on the network.

### Files from other people: `.oto` packages and designs

A `.oto` package or a design can come from anyone, so it is handled as untrusted input (see [docs/PACKAGE-FORMAT.md](docs/PACKAGE-FORMAT.md)):

- The ZIP is parsed strictly: names that could point outside the package are refused and nothing is written to disk under a name taken from a package; sizes are enforced against what each file declares while unpacking (a "zip bomb" is cut off); checksums are verified; there is a cap on files, size and what unpacks.
- Pictures, fonts and sounds are accepted by what is inside the file, not its name or claimed type. SVGs with scripts, event handlers or links are refused. A list of fonts a design asks for (for fonts installed on the computer) may only hold letters, digits, spaces and a few punctuation marks, so it can never carry style code.
- A design can only use files it carries: web addresses are not accepted, so an overlay never contacts a design author's server.
- Design files are served as pictures, fonts and sounds with a `Content-Security-Policy` that stops them running anything even if opened directly.
- A package is installed completely or not at all, and the control settings it can set are limited to a short list (never the card API key, the password or anything specific to one computer).

### What is stored on your computer

Everything is kept in OTO's data folder (`%APPDATA%\obs-tcg-overlay` for the desktop app): the match database, designs, sounds, card libraries and pictures, and logs. Card data and pictures come from third-party services (see [NOTICE.md](NOTICE.md)). Nothing is sent anywhere except requests to those services and, in the installed desktop app, the request to GitHub for release information. The installer's **Destroy** option (and the uninstaller's question) deletes this folder and the updater's downloads, and nothing else; it never runs in an update or a silent install.

### Signed builds

The Windows installers are not code-signed yet, so Windows warns on first run. Download only from this repository's Releases page. See [docs/SIGNING.md](docs/SIGNING.md).

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private reporting instead: go to the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version or commit you tested.

You can expect an acknowledgement within a few days. This is a small volunteer project, so fixes are best-effort.

## Supported versions

Only the latest commit on `main` and the latest release receive fixes.
