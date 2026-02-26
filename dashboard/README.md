# vibez-monitor dashboard

Next.js dashboard for `vibez-monitor`.

## Dev

```bash
npm install
npm run dev
```

Runs on `http://localhost:3100`.

## Build

```bash
npm run build
npm run start
```

## Runtime dependency

The dashboard reads from the same `vibez.db` used by backend scripts.

Set `VIBEZ_DB_PATH` (or keep default `../vibez.db` behavior via root launch scripts) before running in non-default layouts.
