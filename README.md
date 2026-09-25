# cedarstalk-sync

> Built by [Kieran Klukas](https://dunkirk.sh) as part of
> [cedarengine](https://tangled.org/dunkirk.sh/cedarengine) -- all credit is his.
> cedarstalk's changes (auto-connect from the setup page) were made with
> [Claude](https://claude.com/claude-code).

Chrome extension that keeps a [cedarstalk](https://cedarstalk.netlify.app)
database current from the browser you're already signed into. It does no
thinking of its own -- it asks the engine's `/v1/sync/manifest` what's
missing, runs those directory queries and booklist fetches with your own
cookies, and posts the results back. Runs itself every twelve hours by
default.

## Install

1. Download this repo (`Code` → `Download ZIP`) and unzip it, or `git clone`.
   On Windows, right-click the zip → **Extract All** first -- Chrome can't load
   an extension from inside a zip.
2. `chrome://extensions` (or `edge://extensions`) → enable Developer mode → **Load unpacked** → select
   the unzipped folder.
3. Click the extension icon, paste your engine's URL and the bearer token
   you were issued at [cedarstalk.netlify.app](https://cedarstalk.netlify.app),
   press Save.

You need a token before this does anything -- get one at
[cedarstalk.netlify.app](https://cedarstalk.netlify.app) if
you don't have one yet. It's free, takes a `@cedarville.edu` email, and the
engine itself won't start without a valid one.

## What it touches

Only `selfservice.cedarville.edu` and `store.cedarville.edu` by default
(see `manifest.json`'s `host_permissions`) -- the two sites cedarstalk
actually needs to sync from. It talks to your own engine instance over
whatever URL you configure; it has no idea any other engine exists.

This repo is just the extension -- the engine lives at [cedarstalk](https://github.com/leviholliday/cedarstalk).
