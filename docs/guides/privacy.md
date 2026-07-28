# Privacy

rom-weaver is local-first: the browser app processes ROMs, disc images,
patches, archives, and generated outputs on your device instead of uploading
them to a rom-weaver processing service.

<!-- START doctoc -->
## Table of contents

- [File processing](#file-processing)
- [Browser storage](#browser-storage)
- [Network requests](#network-requests)
- [External services](#external-services)
- [Your controls](#your-controls)
- [Questions and changes](#questions-and-changes)

<!-- END doctoc -->

## File processing

Files selected in Weave, Create, Trim, or Tools are read by browser code and the
WebAssembly engine running in dedicated workers. Intermediate files and outputs
stay in browser-managed memory or storage until they are downloaded, removed by
the workflow, evicted by the browser, or cleared through browser controls.

rom-weaver does not require an account and does not send selected ROMs, disc
images, patches, archives, or generated outputs to a rom-weaver server. The CLI
also operates on the files and paths supplied on your computer.

## Browser storage

The webapp uses browser storage to make the app usable across reloads and for
large local workflows:

- Local storage keeps preferences such as theme and settings, update state, and
  a bounded recent application log.
- Session storage coordinates reloads while the service worker establishes the
  browser security mode required for WebAssembly threads.
- Cache Storage keeps versioned application assets so the Progressive Web App
  can load reliably and work offline.
- Origin Private File System storage may hold temporary inputs, intermediate
  files, and outputs that are too large to keep in JavaScript memory.

This storage belongs to the rom-weaver site origin and is controlled by your
browser. The app code does not set advertising or tracking cookies.

## Network requests

Opening the webapp downloads its HTML, styles, scripts, WebAssembly module,
fonts, documentation, and other static assets from the site host. Like other
websites, the hosting and network providers may receive ordinary request data
needed to deliver those files, such as an IP address, user agent, requested
path, and timestamp.

The deployed app does not include analytics, advertising, or behavioral
tracking scripts. If you choose a sample workflow, open a remote bundle, or
provide another remote resource, the browser fetches that specific resource.
The destination server can receive the normal request metadata for that fetch.

## External services

Links to GitHub, Ko-fi, package registries, and other external sites do not load
those services into the app page. They are contacted when you choose to open
the link, and their own privacy terms then apply.

## Your controls

Use your browser’s site-data controls to inspect or clear rom-weaver’s local
storage, cache, service worker, and private file storage. Clearing site data is
the most complete way to remove browser-held rom-weaver data. The app’s Reset
button reloads the current workflow; it is not a substitute for clearing all
site storage.

You can use the CLI when you prefer a workflow without a browser site origin or
service worker. Package downloads and update checks still follow the behavior
of the installer or registry you choose.

## Questions and changes

This page describes the current rom-weaver webapp. Material changes to file
handling, browser storage, analytics, or external services should be reflected
here with the release that introduces them. Questions or corrections can be
reported through the
[public issue tracker](https://github.com/rom-weaver/rom-weaver/issues).
