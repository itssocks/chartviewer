# Chart Viewer (iPad, offline)

An offline chart viewer for iPad that you add to the Home Screen from Safari.
Only this app's code is put online. **Your chart PDFs never leave your devices**: they go
PC → OneDrive → iPad Files app → imported into the app's private storage on the iPad.

> Not an approved EFB. Always check you have current charts (the app shows the cycle
> and dates everywhere, and a red **EXPIRED** banner when a cycle has run out).

---

## 1. Put the app online (one time, about 15 minutes)

We use **GitHub Pages**: free, and updates are one command.

1. Make a free account at <https://github.com>.
2. Click **+** (top right) → **New repository**.
   - Name: `chartviewer`
   - **Public** (needed for free Pages; it only contains this app's code, no charts)
   - Don't tick any "add README / .gitignore" boxes. Click **Create repository**.
3. On the PC, open PowerShell in this app folder (in File Explorer: open the folder,
   click the address bar, type `powershell`, press Enter) and run these, one at a time.
   Replace `YOUR-NAME` with your GitHub user name:

   ```powershell
   git init -b main
   ```
   ```powershell
   git add .
   ```
   ```powershell
   git status
   ```
   Check the list: it must show **only** app files (`index.html`, `sw.js`, `js/…`,
   `css/…`, `vendor/…`, `icons/…`, `tools/…`, `README.md`, `.gitignore`, `manifest.webmanifest`).
   **No `.pdf` and no `_charts_index.json`.** (`.gitignore` blocks them, this is a double check.)
   ```powershell
   git commit -m "Chart Viewer"
   ```
   ```powershell
   git remote add origin https://github.com/YOUR-NAME/chartviewer.git
   ```
   ```powershell
   git push -u origin main
   ```
   The first push opens a browser window to sign in to GitHub - sign in and allow it.
   (If git asks who you are, run `git config --global user.name "Your Name"` and
   `git config --global user.email "you@example.com"`, then repeat the commit.)
4. On github.com, in your `chartviewer` repository: **Settings → Pages**.
   Under **Build and deployment**: Source = **Deploy from a branch**, Branch = **main**,
   folder **/ (root)** → **Save**.
5. Wait 1–2 minutes and refresh that page. It shows your address, e.g.
   `https://YOUR-NAME.github.io/chartviewer/`.

### Updating the app later
If the app code is ever changed: open `sw.js`, raise `VERSION` (e.g. `1.0.0` → `1.0.1`), then:
```powershell
git add .
```
```powershell
git commit -m "Update"
```
```powershell
git push
```
Next time the iPad is online and you open the app, it shows **"App update ready — tap to update"**.
It never updates by itself in the middle of a flight.

---

## 2. Install it on the iPad

1. On the iPad open **Safari** (must be Safari) and go to `https://YOUR-NAME.github.io/chartviewer/`.
2. Tap the **Share** button (square with an arrow) → **Add to Home Screen** → **Add**.
3. Open **Charts** from the Home Screen (always use this icon, not the Safari tab:
   the Home Screen app keeps its own storage and iOS won't clear it after a week).
4. Tap **Import charts** → in the Files picker go to your **Charts** folder (OneDrive) →
   **Select** → pick all the airport PDFs (and `_charts_index.json` if it's there) → **Open**.
   - If files show a cloud icon, OneDrive downloads them first; let it finish.
5. Done. ⚙︎ (top right) shows the cycle, storage used, and every airport with its import date.

---

## 3. Every new cycle (checklist)

On the PC:

1. ☐ Install the new cycle in **JeppViewer** as usual.
2. ☐ In the `Export tool` folder run the export (leave it running; re-run if it stops):
   ```powershell
   py jepp_export.py
   ```
3. ☐ Check `Cycle <number>\_report.txt` (no INCOMPLETE airports), then swap the new PDFs in:
   ```powershell
   py jepp_export.py --replace
   ```
   This copies the PDFs **and** `_charts_index.json` into your Jeppesen folder
   (old ones are moved to `_Old charts`, never deleted).
4. ☐ Copy the new PDFs and `_charts_index.json` into the **Charts** folder that the iPad
   uses (OneDrive), replacing the old ones. Wait for OneDrive to finish syncing.

On the iPad:

5. ☐ Open **Charts** → ⚙︎ → **Import charts…** → select all PDFs + `_charts_index.json` → **Open**.
6. ☐ Read the summary: every airport should be listed, with the new cycle number in green.
   If it offers **Bring notes over**, that's for charts you drew on that did **not** change;
   notes on changed charts stay hidden with the old cycle.
7. ☐ ⚙︎ → check no airport still shows the old cycle. (Delete ones you no longer need.)
8. ☐ Open one chart per airport you're flying to, to make sure it opens.

---

## 4. Test it fully offline (do this before relying on it)

1. Open the app once while online (after installing or updating) and wait a few seconds.
   ⚙︎ should say **"✓ Ready for offline use."**
2. Close the app completely: swipe up from the bottom and hold, then swipe the Charts app away.
3. Turn on **Airplane mode** (and check Wi-Fi is off too).
4. Open **Charts** from the Home Screen. It must start normally.
5. Go through your flight: search an airport, open the airport diagram, a SID, a STAR, an
   approach. Pinch-zoom (it re-sharpens after a moment), double-tap, rotate, swipe to the
   next chart, night mode, draw with the Pencil.
6. Leave a chart open for a few minutes: the screen should stay on.
7. Turn Airplane mode off when done.

If step 4 fails, open the app once online, wait for "Ready for offline use", and repeat.

---

## Using it

- **Going back**: tap ‹, or swipe right from the left edge of the screen, or swipe right along the top bar.
- **Search**: type ICAO, IATA, airport name or city on the first screen.
- **Home**: your DEP/ARR/ALT airports on top, the last 5 charts ("Show all" for more), then
  airports grouped by country.
- **Runway filter**: on an airport, the RWY buttons (All · 03L · 03R …) show only the charts for
  that runway in every tab, and swiping follows it. Charts for every runway (10-9, text pages)
  always show. The choice is remembered per airport.
- **Airport info**: Info / Taxi starts with elevation, transition altitude/level, magnetic
  variation, UTC offset and runways (approx. length, displaced thresholds, ILS). Frequencies and
  declared distances stay on the 10-9.
- **Airport**: tabs Info / Taxi · SID · STAR · Approach · Other. The box at the top
  filters charts by title, e.g. `ILS 03`. ☆ makes a favorite.
- **Flight tabs (DEP / ARR / ALT)**: on an airport screen tap DEP, ARR or ALT to pin it.
  The tabs then sit at the top of every screen; one tap reopens the last chart you had open
  at that airport, a second tap shows its chart list. ✎ edits all three.
- **Chart**: pinch to zoom, drag to pan, double-tap to zoom in / back to fit,
  ⟳ turns the chart 90° and back upright, swipe left/right (when zoomed out) for the next/previous chart in the tab,
  ☾ night mode, ☀︎ slider dims the chart.
- **Apple Pencil**: draws only with the Pencil; fingers always pan and zoom. Red / blue /
  black pen, thin/thick, highlighter, eraser, Undo, Clear. **Off** stops the Pencil drawing.
  Notes are saved per airport + chart number + cycle and never change the PDF.
- **Kneeboard (📝)**: digital paper. Pick a template for a new page (blank, lined, grid,
  IFR clearance + ATIS, Panama VFR (MPMG), time & fuel log) and write with the Pencil. Pages save
  as you write and stay until you delete them. From a chart, 📝 opens your last page and ‹ goes
  straight back to the chart. ＋ adds a page; tap a page name to rename it.
- **Backup (optional)**: ⚙︎ → **Save backup…** makes one small file with your chart notes,
  kneeboard pages, favorites and settings (Save to Files → On My iPad). **Restore backup…** brings it back.
- ⚙︎ **Menus: Auto / Day / Night** for the app's own screens.

## Privacy

- Hosted online: only the files in this folder (app code + pdf.js). `.gitignore` blocks
  `*.pdf` and `_charts_index.json` from ever being committed.
- The app makes no network requests except loading its own files. Charts, notes,
  favorites and settings stay in the iPad's private storage for this app.

## Files

| File | What it is |
|---|---|
| `index.html`, `css/app.css` | The page and its look |
| `js/app.js` | Screens, search, import, favorites, flight tabs |
| `js/viewer.js` | Chart display, zoom, rotation, Pencil drawing |
| `js/notepad.js` | Kneeboard page templates |
| `js/pdfindex.js` | Reads bookmarks / metadata from the PDFs |
| `js/store.js`, `js/opfs-worker.js` | On-device storage |
| `sw.js` | Offline copy of the app (raise `VERSION` after any change) |
| `vendor/pdfjs/` | Mozilla pdf.js 4.10.38 (Apache 2.0 licence), the PDF renderer |
| `tools/make_icons.py` | Draws the Home Screen icons |
