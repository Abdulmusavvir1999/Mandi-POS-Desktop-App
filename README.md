#  POS Launcher

Starts XAMPP MySQL, the POS API and the Angular POS frontend for local
 Shop POS development.

## Requirements
- Windows
- Node.js (npm in PATH)
- XAMPP

## Run
```bash
npm install
npm start
```
Or double-click ** POS Launcher** on the Desktop, which runs `Launch.vbs`:
it clears ELECTRON_RUN_AS_NODE (VS Code and Git Bash set it to 1, which makes
electron.exe start as plain Node with no window) and opens the app with no
console window. **Start Launcher.bat** does the same from a console and installs
Electron if node_modules is missing.

Recreate the shortcut with: target `wscript.exe`, argument the full path to
`Launch.vbs`, working folder the project folder.

> Do **not** open `index.html` by double-clicking it. Outside Electron there is no
> preload bridge, so every button answers `no bridge - main.js must set
> webPreferences.preload to preload.js`.

## Configure
Set the folder and command for each service in the app window - the values are
saved to `launcher-config.json` in the Electron userData folder and reloaded on
the next start. The defaults in `main.js` (`DEFAULT_CONFIG`) are only the fallback; the POS
folders there resolve relative to this one (`../Pos-Backend`, `../Pos-Frontend`),
so the launcher follows the project rather than one machine's absolute paths.

## Start / Stop
Each service has its own Start and Stop, plus Start everything / Stop everything.
A status dot next to each one is refreshed every 4 seconds from the service port
(MySQL 3306, POS API 8000, POS frontend 8002), so Start is disabled while it is up and
Stop while it is down.

Stopping is by port: whatever is LISTENING on the service port is killed, and the
cmd window it was started in is closed with it. MySQL is asked to shut down with
mysqladmin first so InnoDB closes cleanly, and is only killed if that fails.

## Closing the window
If any service is still running, the close button asks first:

- **Stop and exit** - stops the frontend, then the API, then MySQL, then quits
- **Leave them running** - quits and leaves them up
- **Cancel** - stays open

With nothing running it just closes. A shutdown that stalls gives up after 40
seconds and quits anyway, so the window can never be stuck. Killing the app from
Task Manager skips all of this and leaves the services running.

## Behaviour
- **MySQL** runs hidden, like the XAMPP Start button, and the launcher waits for
  port 3306. If MySQL is already running, it says so instead of starting a second one.
- **POS API** (`Pos-Backend`, `npm run dev`) and **POS Frontend** (`Pos-Frontend`,
  `npm start`) each open their own CMD window so the logs stay visible. Both
  folders need `npm install` run once before the launcher can start them.
- The POS API stores its data in SQLite (`Pos-Backend/data/_pos.db`) and
  seeds itself on boot. XAMPP MySQL is started for the MySQL-side tooling -
  phpMyAdmin and the `db:migrate:mysql` / `sync_users` scripts - not because
  the running POS reads from it.

## Debugging
Uncomment `win.webContents.openDevTools(...)` at the end of `createWindow()` in
`main.js`. The console should print `[preload] loaded`; if it does not, preload
did not run.
