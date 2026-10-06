# Code signing

**Short version:** the Windows `.exe` files OTO builds are **not signed today**, so Windows SmartScreen shows a blue *"Windows protected your PC"* screen the first time someone runs one (**More info, then Run anyway** gets past it). OTO can be signed, and the build is already wired for it, but signing needs a **certificate**, which costs money or an application, and only the maintainer can get one in their name. This page says what is in place, what is missing and the ways to get it.

## What a signature does, and does not do

- It proves **who** built the file and that nobody changed it after. Windows shows the publisher's name instead of *Unknown publisher*.
- It does **not** remove the SmartScreen warning at once. SmartScreen also looks at *reputation*, which a new certificate has to earn from downloads over time. An EV certificate used to skip this; today expect a short ramp-up with any kind.
- A **self-signed** certificate (one you make yourself) proves nothing to other people's computers and does not help SmartScreen. It is only good for testing the plumbing.

## What is already in place

The release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)) builds with `npm run dist`, and electron-builder signs the installer and the portable `.exe` when it finds a certificate in two environment variables, which the workflow fills from repository secrets:

| Secret | What it holds |
|--------|---------------|
| `WIN_CSC_LINK` | The certificate as a `.pfx` file: a link to it, or the file encoded as base64 text |
| `WIN_CSC_KEY_PASSWORD` | The password of that `.pfx` |

With no secrets the build is unsigned, exactly as before. After the build, a step prints the signature status of every `.exe` (`Valid`, `NotSigned`, ...). To make the release **fail** when a file is not properly signed, add a repository **variable** (not a secret) called `REQUIRE_SIGNING` with the value `true`.

## Getting a certificate

Ways to do it, from the easiest to the most work. The rules of certificate authorities change, so check each one's current terms.

1. **SignPath Foundation (free for open source).** [SignPath](https://signpath.org/) signs open-source projects for free if the project meets its conditions: public repository, an OSI license (OTO is MIT), no malware or proprietary parts, and builds made in public CI. The signing is done by SignPath's service from the GitHub Actions workflow (it replaces the two secrets above with a SignPath step), and the certificate is issued to the SignPath Foundation, so the publisher name Windows shows is theirs. This is the natural first choice once the repository is public. Apply on their website.
2. **A cloud signing service** such as Microsoft's **Azure Trusted Signing** (the name has been changing; look for "Artifact Signing") or a certificate authority's cloud signing. They keep the key in their hardware for you and sign from the workflow with a short-lived login. Electron-builder has an Azure option (`win.azureSignOptions`). Eligibility depends on the country and the kind of account.
3. **A normal OV or EV certificate** from a certificate authority (SSL.com, Sectigo, DigiCert and others). Since 2023 the private key of a new code signing certificate must live on **hardware** (a USB token or a cloud HSM), so you generally cannot download a plain `.pfx` file to put in a secret. They give you a signing tool or a cloud service to sign with instead; the workflow then needs a signing step for that tool.

None of this is needed to use or develop OTO. It only decides whether strangers see a warning when they download it.

## Setting it up once you have a certificate

If you have a `.pfx` (an older certificate, or a provider that exports one):

1. Encode it: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard` (PowerShell).
2. In the repository, **Settings, Secrets and variables, Actions**, add `WIN_CSC_LINK` (paste the base64 text) and `WIN_CSC_KEY_PASSWORD`.
3. Push a version tag, or run the **Release** workflow by hand. Read the *Say whether the files are signed* step: it should say `Valid`.
4. Add the variable `REQUIRE_SIGNING=true` so a release can never go out unsigned by mistake.

To check a file yourself: `Get-AuthenticodeSignature .\OTO-Setup-1.0.0.exe | Format-List` (PowerShell), or right-click the file, **Properties**, **Digital Signatures**.

For SignPath or a cloud service, follow its own instructions for GitHub Actions and replace or add to the build step; the check step at the end of the workflow keeps working.

## Updates and signing

The installed app updates itself from GitHub Releases. Once releases are signed, consider setting `build.win.publisherName` in `package.json` to the exact name on the certificate: the updater then only accepts update files signed by that publisher. Set it from the first signed release on: copies installed before that do not carry the check, so they keep updating normally.
