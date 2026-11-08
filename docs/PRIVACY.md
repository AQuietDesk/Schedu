# Schedu privacy notice

Last updated: November 7, 2026

Schedu is a Windows planner made by AQuietDesk. This notice explains what Schedu does with your
information. In short: everything stays on your PC unless you turn on a feature that needs to go
online, and AQuietDesk never receives any of it.

## What stays on your PC

Your tasks, classes, grades, notes, focus sessions and settings are saved in a database on your
computer, in `%APPDATA%\app.schedu.desktop`. AQuietDesk has no server that stores or receives
this data, and Schedu has no accounts, analytics, advertising or tracking.

## What leaves your PC, and only when you turn it on

| Feature | What is sent | Where |
| --- | --- | --- |
| Google Calendar and Tasks (optional) | The items you sync (title, due date, notes, done) are written to your own Google Tasks, and changes to them are read back. Your calendars' events are read to show them in Schedu | Google, using your Google account |
| Backups (optional) | A full copy of your Schedu database, without your Google sign-in | The folder you choose. If that folder is synced by Google Drive, OneDrive or Dropbox, that service stores the copy under its own terms |
| Weather (optional) | The city name you type in Settings | Open-Meteo (open-meteo.com) |
| Update check (automatic) | A request asking whether a newer version exists. It carries no data from the app | GitHub, where Schedu releases are hosted |
| Schedu Pro licence (Pro only) | Your licence key, a salted fingerprint of your PC (not the raw Windows ID), your computer's name, the app version and the operating system; on activation and about once a week after | Polar (polar.sh), which issued the key |
| Schedu Pro syllabus import (Pro only, each time you import) | The syllabus file you choose, plus the class name, its term, today's date and its grade category names | Anthropic (anthropic.com), using your own Anthropic API key |

Any service Schedu contacts can see your computer's IP address, as with any internet request.

## Google user data

When you connect a Google account, Schedu asks Google for permission to:

- see your calendars and their events (`calendar.readonly`): Schedu lists your calendars so you
  can pick which to show, and reads their events live to display them in its Today and Calendar
  views. Schedu never saves, creates or changes calendar events;
- see, create, change and delete tasks (`tasks`): Schedu adds the Schedu items you sync to
  Google Tasks, keeps them up to date, deletes them when you delete the item, and reads back
  changes you make to those same tasks (title, notes, done, deleted). It doesn't import your
  other Google Tasks.

Schedu doesn't ask for your email address or profile. The sign-in tokens Google issues are
stored only on your PC, in Windows Credential Manager. They're never included in backups and
never sent to AQuietDesk or anyone else. Google user data is never sent to Anthropic or any AI
service. Schedu doesn't sell
Google data, use it for advertising, or use it to train AI models, and no person at AQuietDesk can
read it.

Schedu's use and transfer to any other app of information received from Google APIs will
adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

To stop sharing, choose **Settings → Google → Disconnect**. That revokes Schedu's access at
Google and deletes the tokens from your PC. You can also remove Schedu at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions). Items you synced
stay in Schedu until you delete them or the app's data folder, and events and tasks Schedu
created in your Google account stay there until you delete them.

## Schedu Pro

Schedu Pro adds syllabus import. **Everything Pro saves is stored only on your own computer:
your Anthropic API key, your licence key, the rows read from a syllabus, and the items you
import. None of it is stored by AQuietDesk or anywhere else by Schedu, and AQuietDesk has no
server that could receive it.**

- **Your Anthropic API key** is saved only on this PC, in Windows Credential Manager, set so
  it never syncs or roams to other computers. It isn't in Schedu's database, so it's never in
  your backups. It's sent only to Anthropic, to sign in your own requests (each import, and
  when you press **Test**), the same way a password is sent to log in. AQuietDesk never
  receives it.
- **Syllabus files** go from your PC straight to Anthropic's API under your own Anthropic
  account, and Anthropic handles them under its own terms
  ([Anthropic's privacy policy](https://www.anthropic.com/legal/privacy)). Schedu doesn't keep
  a copy of the file. It keeps, on your PC, the rows it read until you review them and the
  items you approve. Duplicate checking against the class's existing items happens on your PC
  after Anthropic replies; those items aren't sent. Google user data is never sent to Anthropic
  or any AI service.
- **Your licence key** and its activation record are saved only on this PC, the same way as
  the API key. Polar, which issued the key, sees the details in the table above so it can limit
  how many computers a key unlocks. **Settings → Schedu Pro → Remove from this PC** deletes them
  from your PC and frees the slot.
- Installing Pro downloads the Pro version from GitHub, like any update.

## Buying Schedu

If you pay for Schedu or subscribe to Schedu Pro, the purchase is handled by Polar (polar.sh), which acts as the seller of
record and processes your payment under its own privacy policy. AQuietDesk receives your
email address and order details from Polar so it can provide support and refunds. It doesn't
receive your card details.

## Deleting your data

Uninstall Schedu from **Settings → Apps** in Windows and tick **Delete the application data**, or
delete the `%APPDATA%\app.schedu.desktop` folder yourself. Delete any backup copies in the
folder you chose. If you used Schedu Pro, first choose **Settings → Schedu Pro → Remove from
this PC** and remove your API key on the same page, which deletes both from Windows Credential
Manager. Nothing else needs to be deleted, because nothing else is kept.

## Children

Schedu isn't directed at children under 13, and AQuietDesk doesn't knowingly collect
information from them.

## Changes

If this notice changes, the new version will be posted at the same address with a new date. A
change that sends any new data off your PC will also be listed in the release notes.

## Contact

Email [discover@aquietdesk.com](mailto:discover@aquietdesk.com).
