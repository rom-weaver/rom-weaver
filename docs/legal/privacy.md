# Privacy

Your files stay on your device. rom-weaver does the work in your browser
instead of uploading anything to a server.

<!-- START doctoc -->
## Table of contents

- [What happens to your files](#what-happens-to-your-files)
- [What your browser stores](#what-your-browser-stores)
- [What the app downloads](#what-the-app-downloads)
- [Links to other sites](#links-to-other-sites)
- [How to clear everything](#how-to-clear-everything)
- [Questions and changes](#questions-and-changes)

<!-- END doctoc -->

## What happens to your files

When you pick a file in Weave, Create, Trim, or Tools, it is read by code
running inside your own browser. The patching engine runs there too, as
WebAssembly in background workers. Nothing about that requires a server.

There is no account to make, and your ROMs, disc images, patches, archives,
and results are not sent to a rom-weaver server. The command-line tool is the
same story: it reads and writes the paths you give it on your own computer.

Files stay in browser memory or browser storage while you work, and are gone
once you download the result and the workflow releases them, or your browser
clears its own storage, or you clear it yourself.

## What your browser stores

The app keeps a few things locally so it works across reloads and can handle
files too big to hold in memory:

- **Local storage**: your preferences, such as theme and settings, plus
  update state and a short recent log.
- **Session storage**: coordinates a reload while the service worker turns on
  the browser security mode that WebAssembly threads need.
- **Cache storage**: the app's own files, so it loads fast and works offline.
- **Origin Private File System**: temporary inputs, working files, and outputs
  that are too large for memory.

All of it belongs to the rom-weaver site in your browser and is under your
browser's control. The app sets no advertising or tracking cookies.

## What the app downloads

Opening the site downloads what any site downloads: HTML, styles, scripts,
the WebAssembly module, fonts, and these pages. As with any website, whoever
hosts and routes that traffic can see ordinary request information: an IP
address, a browser user agent, the path requested, and a timestamp.

There are no analytics, advertising, or tracking scripts in the deployed app.

If you open a sample workflow, a bundle from a URL, or any other remote file,
your browser fetches that one thing from wherever it lives, and that server
sees the same ordinary request information.

## Links to other sites

Links to GitHub, Ko-fi, package registries, and anywhere else are just links.
Nothing from those sites is loaded into the app page. They are contacted only
when you click, and from then on their own privacy terms apply.

## How to clear everything

Use your browser's site-data controls to look at or delete rom-weaver's local
storage, cache, service worker, and private file storage. Clearing site data
is the thorough option and removes everything listed above.

The app's own Reset button is not that. It reloads the workflow you are in and
leaves stored data alone.

If you would rather not have a site origin or a service worker involved at
all, use the command-line tool. Installing it and checking for updates still
follows the normal behavior of whichever installer or registry you use.

## Questions and changes

This page describes the rom-weaver webapp as it is now. If how files are
handled, what the browser stores, or what the app talks to ever changes in a
way that matters, this page should change in the same release.

Questions and corrections go to the
[public issue tracker](https://github.com/rom-weaver/rom-weaver/issues).

Back to the [guide index](../usage/README.md).
