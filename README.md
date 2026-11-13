# lifetime

A timeline of your life told through rolls of developed film. Drop a folder of photos into a watched directory, name the roll, give it a timeframe, and it appears as a point on a horizontal timeline. Click a point to explore the roll as photos floating in 3D space, and add captions to each one.

## Stack

- **Backend:** ASP.NET Core (minimal APIs), SQLite via EF Core (coming), ImageSharp (coming), SignalR (coming)
- **Front end:** React + TypeScript + Vite, React Three Fiber for the 3D gallery (coming)

## Repo layout

```
src/
  Lifetime.Api/   ASP.NET Core API, also serves the built front end from wwwroot
  web/            Vite + React + TypeScript app
```

## Running in development

Two terminals:

```bash
# 1. API (http://localhost:5080)
cd src/Lifetime.Api
dotnet run

# 2. Front end (http://localhost:5173, proxies /api to the API)
cd src/web
npm install
npm run dev
```

Open http://localhost:5173. You should see "lifetime" and an API status of "ok".

## Running as a single app

```bash
cd src/web
npm install
npm run build        # outputs into src/Lifetime.Api/wwwroot
cd ../Lifetime.Api
dotnet run           # open http://localhost:5080
```

## Configuration

The watched photos folder is set in `src/Lifetime.Api/appsettings.json`:

```json
{ "Lifetime": { "PhotosFolder": "~/Pictures/lifetime-rolls" } }
```

Override it locally in `appsettings.Development.json` (git-ignored). `~` expands to your home directory.

## Roadmap

Features are tracked as GitHub issues, built one at a time.
