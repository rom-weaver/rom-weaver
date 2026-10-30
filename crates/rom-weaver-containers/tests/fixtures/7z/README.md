# Deflate64 BCJ regression fixture

`deflate64-bcj.7z` was generated with p7zip 17.05. It contains `mixed.bin`, 1,048,576 bytes with byte `i` equal to `i % 251`. The archive is 7,302 bytes. The CLI regression test reconstructs and compares the full payload.

After generating `mixed.bin`, the archive command is:

```sh
7z a -t7z -mf=BCJ -m0=Deflate64 -mtm=off -mtc=off -mta=off deflate64-bcj.7z mixed.bin
```

`7z x` reproduces the original payload. The BCJ filter exercises draining the Deflate64 decoder after all compressed bytes have been consumed.
