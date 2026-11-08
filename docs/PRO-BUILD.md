# Schedu Pro: how it's built, sold and protected

## How a buyer gets Pro

1. In the free app, **Settings → Schedu Pro → Get Schedu Pro** opens
   `aquietdesk.com/schedu-pro/buy`, which forwards to the Polar checkout.
2. Polar emails a licence key. The buyer pastes it into the same Settings page and presses
   **Activate**.
3. The free app shows **Download Schedu Pro → Install**. It downloads the signed Pro build
   through the built-in updater from the Pro release channel, installs it over the free app and
   restarts. Data stays put (same app ID, same data folder).
4. In Pro, the buyer adds their own Anthropic API key (same page, with a 3-step checklist),
   presses **Test**, and **Import syllabus** on any class page starts working.

From then on the Pro build updates itself from the Pro channel.

## Why Pro is a separate download

The free installer contains none of the syllabus-reading code. The public repo builds against
a stub in `src-tauri/pro`, and only the release workflow swaps in the private crate. So:

- nobody can build Pro from the public source;
- patching the free app unlocks nothing, because there's nothing in it to unlock;
- the Pro installer is public (the updater has to reach it), but it does nothing without an
  activated key.

What this doesn't stop, and no desktop app can: someone with a Pro build and a valid key
patching the licence check out of their own copy. For a low-priced tool where the user also
pays Anthropic for every import, that isn't worth guarding against further. Polar's limits do
the rest:

| Layer | What it stops |
| --- | --- |
| Pro code only in the Pro build | Building or unlocking Pro from the free app or public source |
| Activation limit per key (set on the Polar benefit) | Sharing one key widely |
| Machine condition on each activation (salted hash of the Windows machine id) | Copying an activation to another PC; Polar rejects the mismatch |
| Benefit check on activate and validate | Using a key from another AQuietDesk product (Money Plan OS) |
| Weekly re-check, 30-day offline grace | Using Pro long after a subscription ends |
| Cached record sealed with a key that exists only in the private crate | Editing the cached licence to extend the grace period |
| Your own Anthropic key (BYOK) | AQuietDesk paying for anyone's usage, cracked or not |

## Setup still needed before the first Pro release

1. **Polar**: create the Schedu Pro yearly subscription with a **License Keys** benefit
   (prefix e.g. `SCHEDU`, activation limit e.g. 3, "Enable user to deactivate instances" on).
   Test it in Polar's sandbox first.
2. **GitHub variable** `SCHEDU_PRO_BENEFIT_ID` on AQuietDesk/Schedu = that benefit's id. Until
   it's set, the app says Pro isn't on sale and refuses every key. Once it's set, the key field
   shows straight away (for test purchases), but the "Get Schedu Pro" buttons only appear from
   the launch date in `license::launched` (Jan 4, 2027, midnight Eastern).
3. **Private repo** AQuietDesk/schedu-pro (holds the crate) and a read-only **deploy key**:
   public half on schedu-pro, private half as secret `SCHEDU_PRO_DEPLOY_KEY` on Schedu.
4. **Public repo** AQuietDesk/schedu-pro-releases (empty; releases only) and a fine-grained
   token with Contents: write on it, as secret `PRO_RELEASES_TOKEN` on Schedu.
5. **Website**: `aquietdesk.com/schedu-pro/buy/index.html`, a meta-refresh to the Polar
   checkout link, same as `/buy`.
6. Test end to end: sandbox purchase → activate in the free app → Install → import a syllabus
   → Undo → Remove from this PC.

## Releasing

Tag `vX.Y.Z` as before. The workflow builds the free app, then the Pro app with the same
version number, signed with the same updater key, and publishes it to schedu-pro-releases.

## Working on Pro locally

```powershell
./scripts/pro-build.ps1 -ProPath ..\schedu-pro -Command test   # tests with the private crate
./scripts/pro-build.ps1 -ProPath ..\schedu-pro -Command dev    # run the Pro app
```

The script checks that `src/types.rs` is identical in the stub and the private crate, swaps the
private crate in, runs the command, then restores the stub and `Cargo.lock`. Never ship a local
build; they embed this PC's paths.

## What lives where

| Public (this repo) | Private (schedu-pro) |
| --- | --- |
| `src-tauri/pro`: stub with the shared types | The same types, the Anthropic client, the prompt and schema, Word reading, the date and flag rules, the sealing key |
| `license.rs`, `secrets.rs`, `pro.rs`: licence, Credential Manager, upgrade download | |
| `intake.rs`: saving approved rows, undo | |
| Settings → Schedu Pro, the import dialog, the review page | |
