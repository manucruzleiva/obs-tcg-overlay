# Contributing to OTO (obs-tcg-overlay)

Thanks for your interest in contributing! This guide covers how to contribute, how to set up the project, and what a good pull request looks like.

By submitting a contribution you agree that it is licensed under the project's [MIT license](LICENSE).

## Every change is a pull request

**If you want to add to the project, open a pull request.** There are no direct pushes to `main`: it is a protected branch, and every change, including the maintainers' own, arrives through a pull request that passes CI and is reviewed.

1. **Discuss first for anything big.** For a new feature or a large change, open an [issue](https://github.com/manucruzleiva/obs-tcg-overlay/issues/new/choose) so we can agree on the approach before you spend time on it. Bug fixes, docs and small improvements can go straight to a pull request.
2. **Fork the repository** (or create a branch if you have been given write access) and branch from `main`: `git checkout -b feat/short-description`.
3. **Make a focused change.** One topic per pull request, with tests for new behavior.
4. **Open a pull request against `main`** and fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) that appears. It asks what changed and why, how you tested it, and for screenshots of anything visual.
5. **Wait for CI and review.** The checks must pass, and a maintainer must approve. Expect some back-and-forth; push follow-up commits to the same branch.
6. **A maintainer merges it** (squash merge, so the pull request title becomes the commit message; use a [Conventional Commit](https://www.conventionalcommits.org/) title).

Pull requests that are not described, do not pass `npm test`, or mix unrelated changes will be asked to be split or fixed before review.

## Getting started

You need Node.js 22+ and Git. Building the Windows `.exe` also requires Windows.

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/<your-username>/obs-tcg-overlay.git
cd obs-tcg-overlay
npm install
npm start          # http://localhost:6767/control
```

Useful commands:

| Command | What it does |
|---------|--------------|
| `npm start` | Run the server only |
| `npm run electron:dev` | Run the server and the Electron window |
| `npm test` | Run the server and logic tests (real server, mock card API; a minute or so) |
| `npm run test:ui` | Run the control panel and settings in a real browser. Needs Chrome or Edge (set `BROWSER_PATH` to use another) |
| `npm run test:desktop` | Run the Electron app end to end (needs the Electron binary: `npm install` without `--ignore-scripts`) |
| `npm run pack` | Build an unpacked Electron app into `dist/` |
| `npm run dist` | Build the Windows installer and portable `.exe` into `dist/` |

The architecture, the project layout, the configuration and the API are in the [developer guide](docs/DEVELOPING.md).

### The `.local/` folder

`.local/` is gitignored scratch space. The tests write their throwaway databases, designs and logs to `.local/test/`, and it is a good place for one-off scripts, screenshots, installer test builds and other files that should never be committed. Anything you want to keep in the project belongs outside it.

## Writing the change

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add best-of-5 score reset
fix: clamp prizes to 0..6
docs: correct keyboard shortcut table
refactor: extract damage selector state
test: cover clearSlot for bench slots
chore: update dependencies
```

### Code style

- JavaScript: 2-space indentation, semicolons, single quotes, no trailing whitespace (see [.editorconfig](.editorconfig))
- Match the style of the surrounding code; keep changes focused and avoid unrelated reformatting
- CSS: use the design tokens in `public/css/tokens.css` instead of hard-coded colors, and avoid `!important`
- HTML: semantic elements, and `aria-*` attributes on interactive controls

### How the control panel talks to the server

A click in the control panel becomes a socket event, `action:<target>` with `{ action, ...params }`. The server handles it in three layers:

1. [src/session.js](src/session.js) checks who sent it, detects conflicts between producers, applies it, and keeps the history and the activity feed.
2. [src/actions.js](src/actions.js) is the registry of every action: how to validate it, which part of the game it touches (so two producers changing the same thing are noticed), and how to describe it.
3. [src/services/gamestate.js](src/services/gamestate.js) holds the game state and the methods that change it.

When you add a control, add a method to the game state if needed, an entry to the action registry (with its `targets` and `label`), the control itself, and a test in `tests/server/`. If it changes what a producer sees or clicks, add or extend a test in `tests/ui/` too.

### Documentation

The docs are written for three kinds of reader, so put a change where its reader will look:

- [docs/USING.md](docs/USING.md): streamers and producers (no code, plain words, what to click and press)
- [docs/DESIGNING.md](docs/DESIGNING.md) and [docs/PACKAGE-FORMAT.md](docs/PACKAGE-FORMAT.md): artists and designers (the guide, and the exact format)
- [docs/DEVELOPING.md](docs/DEVELOPING.md): developers (architecture, configuration, API, tests)

The [README](README.md) stays short: a taste of each, with links. Add a line to `CHANGELOG.md` for anything a user can notice.

### Tests

- `tests/server/` holds server and logic tests with `node:test` (`npm test`). They boot the real server through [tests/support/harness.js](tests/support/harness.js) (a throwaway database, a mock card API and card image host) and drive it over HTTP and socket.io. Use a **fresh client id for each test producer**: the server ignores an action it has already seen from the same client id and sequence number.
- `tests/ui/` (`npm run test:ui`) drives the control panel and settings in a real browser with `playwright-core`; no browser is downloaded, it uses the Chrome or Edge you already have. Wait for the page to show a change before pressing the next key, rather than sleeping.
- `tests/desktop/` (`npm run test:desktop`) launches the Electron app in a throwaway data folder (`OTO_DATA_DIR`) on its own port (`OTO_PORT`). Run it before a release.
- Never write a test that depends on the real card API or the internet.

## Pull request checklist

The pull request template includes this list; please tick it honestly.

- [ ] The change is described clearly and links the issue it addresses
- [ ] `npm test` passes (and `npm run test:ui` if you changed the control panel, settings or overlay)
- [ ] No new console errors in the control panel or overlay
- [ ] Docs and `CHANGELOG.md` updated if behavior changed
- [ ] Screenshots or a short recording for visible UI changes
- [ ] No secrets, passwords or personal data in the diff

## Reporting bugs

Please [open an issue](https://github.com/manucruzleiva/obs-tcg-overlay/issues/new/choose) and include:

- What you did, what you expected, and what happened
- Your OS, browser, Node.js and OBS versions
- Whether you use the desktop app or `npm start`
- Relevant lines from the `logs/` directory (the desktop app writes logs to its user-data folder)

For security problems, do **not** open a public issue; see [SECURITY.md](SECURITY.md).

## Feature requests

Open an issue describing the problem you want to solve and how you imagine it working. Mockups help.

## Dependencies

Keep dependencies current and free of known vulnerabilities. Dependabot opens weekly update pull requests for npm packages and GitHub Actions, and CI runs `npm audit` on the production dependencies. Before sending a dependency change, run `npm audit` and `npm test`. For Electron or electron-builder bumps also run `npm run dist` and start the built app.

Workflow actions are pinned to a commit SHA (with the version in a comment); Dependabot updates both.

## Releasing (maintainers)

Releases are built by GitHub Actions ([release.yml](.github/workflows/release.yml)); you do not need to build locally.

1. In a pull request, move the `Unreleased` notes in `CHANGELOG.md` under the new version heading and bump the version in `package.json`
2. After it is merged, tag the merge commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`
3. The workflow checks that the tag matches `package.json`, runs the tests, builds the Windows installer and portable `.exe`, and publishes them with `latest.yml` as a GitHub Release

Installed copies (the installer build, not the portable one) pick the new version up automatically from that release. A tag containing a hyphen, such as `v1.3.0-beta.1`, is published as a pre-release and is not offered to installed apps.

The build is unsigned unless the repository has a code signing certificate in its secrets: see [docs/SIGNING.md](docs/SIGNING.md).

To test the build without publishing, run the **Release** workflow manually from the Actions tab; the files are attached to the run instead.
