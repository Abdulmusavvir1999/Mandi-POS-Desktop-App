# POS Setup on a New Windows PC

Sets up the whole POS (Pos-Backend, Pos-Frontend and Pos-Desktop) on a new
Windows 10/11 PC with nothing installed.

**What gets installed**

| Tool | Version | How |
|---|---|---|
| Git | latest | winget |
| Node.js + npm | 22 LTS | winget |
| XAMPP (MySQL) | 8.2 | winget |
| Angular | 19 | `npm install` in Pos-Frontend |
| Express | 4 | `npm install` in Pos-Backend |
| Electron | 31 | `npm install` in Pos-Desktop |

> Run every command in **PowerShell as Administrator**
> (Start menu, type `PowerShell`, right-click it, then choose **Run as administrator**).

---

## Option A: One command (recommended)

Paste this and wait for **POS setup complete**:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; irm https://raw.githubusercontent.com/Abdulmusavvir1999/Mandi-POS-Desktop-App/main/setup.ps1 | iex
```

It runs every step in Option B for you. Then go to [Start the POS](#start-the-pos).

If it stops with *"did not install"*, restart the PC and paste the same command
again. It skips whatever is already done.

---

## Option B: Step by step

### 1. Install Git, Node.js 22 and XAMPP

```powershell
winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.22 --exact --silent --accept-package-agreements --accept-source-agreements
winget install --id ApacheFriends.Xampp.8.2 --exact --silent --accept-package-agreements --accept-source-agreements
```

**Close PowerShell and open it again as Administrator**, so the new tools are
found. Then check them:

```powershell
git --version; node -v; npm -v
```

### 2. Clone the project

The three folders must sit side by side in one folder. The launcher looks for
`..\Pos-Backend` and `..\Pos-Frontend`.

```powershell
mkdir "$env:USERPROFILE\Desktop\Pos"; cd "$env:USERPROFILE\Desktop\Pos"
git clone https://github.com/Abdulmusavvir1999/Mandi-POS-BE.git Pos-Backend
git clone https://github.com/Abdulmusavvir1999/Mandi-POS-FE.git Pos-Frontend
git clone https://github.com/Abdulmusavvir1999/Mandi-POS-Desktop-App.git Pos-Desktop
```

### 3. Install packages

```powershell
cd "$env:USERPROFILE\Desktop\Pos\Pos-Backend"; npm install
cd "$env:USERPROFILE\Desktop\Pos\Pos-Frontend"; npm install
cd "$env:USERPROFILE\Desktop\Pos\Pos-Desktop"; npm install
```

### 4. Create the backend `.env`

XAMPP's MySQL uses user `root` with an empty password. The host is `127.0.0.1`,
because `localhost` can point somewhere else (for example to Docker). This also
generates random JWT secrets.

```powershell
cd "$env:USERPROFILE\Desktop\Pos\Pos-Backend"
(Get-Content .env.example) -replace '^LOC_DB_HOST=.*','LOC_DB_HOST=127.0.0.1' -replace '^LOC_DB_USER=.*','LOC_DB_USER=root' -replace '^LOC_DB_PASS=.*','LOC_DB_PASS=' -replace '^DB_HOST=.*','DB_HOST=127.0.0.1' -replace '^DB_USER=.*','DB_USER=root' -replace '^DB_PASSWORD=.*','DB_PASSWORD=' -replace '^JWT_SECRET=.*',"JWT_SECRET=$([guid]::NewGuid())$([guid]::NewGuid())" -replace '^JWT_REFRESH_SECRET=.*',"JWT_REFRESH_SECRET=$([guid]::NewGuid())$([guid]::NewGuid())" | Set-Content .env -Encoding ascii
```

### 5. Create the database

Start MySQL:

```powershell
Start-Process "C:\xampp\mysql\bin\mysqld.exe" -ArgumentList '--defaults-file=C:\xampp\mysql\bin\my.ini','--standalone' -WindowStyle Hidden
```

Wait about 10 seconds, then create the `pos` database and load the tables and
starting data:

```powershell
cd "$env:USERPROFILE\Desktop\Pos\Pos-Backend"
C:\xampp\mysql\bin\mysql.exe -h 127.0.0.1 -u root -e "CREATE DATABASE IF NOT EXISTS pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
cmd /c "C:\xampp\mysql\bin\mysql.exe -h 127.0.0.1 -u root --default-character-set=utf8mb4 pos < src\database\schema.sql"
cmd /c "C:\xampp\mysql\bin\mysql.exe -h 127.0.0.1 -u root --default-character-set=utf8mb4 pos < src\database\seeders.sql"
```

Stop MySQL again. The launcher starts it later.

```powershell
C:\xampp\mysql\bin\mysqladmin.exe -h 127.0.0.1 -u root shutdown
```

> Run step 5 only on a **new, empty** database.

### 6. Create the Desktop shortcut

```powershell
$d="$env:USERPROFILE\Desktop\Pos\Pos-Desktop"; $s=(New-Object -ComObject WScript.Shell).CreateShortcut("$env:USERPROFILE\Desktop\POS Launcher.lnk"); $s.TargetPath='wscript.exe'; $s.Arguments="`"$d\Launch.vbs`""; $s.WorkingDirectory=$d; $s.Save()
```

---

## Start the POS

1. Double-click **POS Launcher** on the Desktop.
2. Click **Start everything**. This starts MySQL, then the API, then the frontend.
3. Open **http://localhost:8002**.

| Service | Port |
|---|---|
| MySQL | 3306 |
| POS API | 8000 |
| POS Frontend | 8002 |

### Logins

All five logins share one password, `Super@123`. **Change it before real use.**

| Username | Role |
|---|---|
| `superadmin` | Super administrator (back office) |
| `admin` | Admin |
| `manager` | Manager |
| `cashier` | Cashier |
| `staff` | Staff |

A new install has users, roles and settings, but no menu, dining tables or
stock. Add those from the admin screens.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `winget` not found | Install **App Installer** from the Microsoft Store. |
| `git`, `node` or `npm` not found | Close and reopen PowerShell as Administrator, or restart the PC. |
| `Access denied for user 'root'` | `.env` must use `127.0.0.1`, not `localhost` (step 4). |
| MySQL won't start | Check whether port 3306 is taken: `netstat -ano \| findstr :3306`. Read `C:\xampp\mysql\data\mysql_error.log`. |
| `schema.sql` error *"Key column 'is_deleted' doesn't exist"* | Pos-Backend is an old copy. Run `git pull` in Pos-Backend, drop the `pos` database and repeat step 5. |
| Launcher opens with no window | Always start it with the **POS Launcher** shortcut or `Start Launcher.bat`, never `index.html`. |
