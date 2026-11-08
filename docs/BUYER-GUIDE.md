# Schedu: getting started

Thanks for getting Schedu. This page covers installing it, keeping your data safe, and getting help.

## Install (Windows 10 or 11)

1. Download **Schedu_x.y.z_x64-setup.exe** from your Polar order.
2. Double-click it. Windows may show **"Windows protected your PC"**. This appears for apps from
   small independent makers that haven't bought a code-signing certificate yet. Click
   **More info**, check that the app name is `Schedu_x.y.z_x64-setup.exe`, then click **Run anyway**.
3. The installer finishes in a few seconds and doesn't need admin rights. Open **Schedu** from
   the Start menu.

To have Schedu start with Windows, turn on **Settings → General → Startup**. It then opens quietly in the
tray, so reminders still arrive while the window is closed.

## Your data stays on your computer

Everything you enter is saved in `%APPDATA%\app.schedu.desktop` on your PC. Schedu only goes
online for features you turn on (Google sync, weather) and to check for updates. The full
details are in the privacy notice: https://aquietdesk.com/privacy

## Connect Google Calendar and Tasks (optional, beta)

**Settings → Google → Connect** opens Google sign-in in your browser. While Google reviews
Schedu, it may say **"Google hasn't verified this app"**. Click **Advanced**, then
**Go to Schedu (unsafe)**, then allow Calendar and Tasks access. Schedu never sees your password.

## Don't lose your data

- **Backups:** in **Settings → Backup**, choose a folder. A Google Drive, OneDrive or Dropbox folder
  works well, because it puts the copy off your PC. Schedu saves a full copy there on a schedule
  and keeps the previous copy too.
- **New computer:** install Schedu, choose the same backup folder, and accept the offer to restore.
- Backups don't include your Google sign-in. Reconnect Google on the new computer.

## Updates

Schedu checks for a new version each time it starts. If there is one, it installs it and
restarts itself, usually within a few seconds of opening. Your data is not affected.

## Schedu Pro: import a syllabus

1. Buy Schedu Pro from **Settings → Schedu Pro → Get Schedu Pro**. Polar emails you a licence key.
   Pro is a yearly subscription and isn't refundable, so try **Import syllabus** first to see what
   it does.
2. Paste the key into the same page and press **Activate**, then **Install**. Schedu downloads
   the Pro version, installs it over itself and restarts. Your data stays where it is.
3. Add your own Anthropic API key, on the same page. Create an account at platform.claude.com,
   add a few dollars of credit, create an API key, paste it in, and press **Test**. Each syllabus
   costs a few cents on your Anthropic account.
   Your key is saved only on your PC and is sent only to Anthropic. AQuietDesk never sees it.
4. Open a class and press **Import syllabus**. Choose the PDF or Word file. In under a minute
   you'll see every deliverable it found. Rows that need a look (no date, only a week number,
   outside the term, in a reading week, already in the class) are listed first. Check each one
   against its source text, fix anything, then press **Add**.
5. Changed your mind? **Undo** next to the import on the class page removes everything it added.

## Help and refunds

Email **discover@aquietdesk.com**. Paid and changed your mind? You get a full refund within 30
days, no questions asked. Details: https://aquietdesk.com/schedu/terms/

## Uninstall

**Settings → Apps → Schedu → Uninstall** in Windows. Your data is kept unless you tick
**Delete the application data**, so make a backup first if you want to keep it.
