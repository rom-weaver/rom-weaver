# Deflate64 BCJ regression fixtures

`deflate64-bcj.7z` was generated with p7zip 17.05. It contains `mixed.bin`, 1,048,576 bytes with byte `i` equal to `i % 251`. The archive is 7,302 bytes. The CLI regression test reconstructs and compares the full payload.

After generating `mixed.bin`, the archive command is:

```sh
7z a -t7z -mf=BCJ -m0=Deflate64 -mtm=off -mtc=off -mta=off deflate64-bcj.7z mixed.bin
```

`7z x` reproduces the original payload. The BCJ filter exercises draining the Deflate64 decoder after all compressed bytes have been consumed.

## CALL and JMP conversions

`deflate64-bcj-calls.7z` was generated with p7zip 17.05. It contains `calls.bin`, 1,048,576 bytes, and occupies 4,972 bytes. Every complete five-byte instruction alternates CALL (`E8`) and JMP (`E9`), targeting absolute address `0x200000`. Relative operands cross 64 KiB boundaries. BCJ changes these operands into repeated absolute targets, keeping the fixture small.

Generate the original payload with Python 3:

```python
from pathlib import Path

payload = bytearray(1024 * 1024)
for offset in range(0, len(payload) - 4, 5):
    payload[offset] = 0xE8 if offset % 10 == 0 else 0xE9
    relative = 0x200000 - offset - 5
    payload[offset + 1:offset + 5] = relative.to_bytes(4, "little", signed=True)
Path("calls.bin").write_bytes(payload)
```

```sh
7z a -t7z -mf=BCJ -m0=Deflate64 -mtm=off -mtc=off -mta=off deflate64-bcj-calls.7z calls.bin
```

The CLI test extracts with one and two threads and compares every byte with the reconstructed payload.

## Multiple empty-input drains

`deflate64-bcj-long-match.7z` is a handcrafted 182-byte archive containing `long-match.bin` (851,922 bytes). p7zip 17.05 validates and extracts it. Its decoded BCJ stream starts with seven `90` bytes, then repeats `E8 00 00 20 00 90 E9 00 00 20 00 90`. The original payload replaces each complete instruction operand with signed little-endian `0x200000 - offset - 5`.

The single final fixed-Huffman Deflate64 block contains the 19-byte literal seed, a 65,447-byte match, twelve 65,538-byte matches, and the end-of-block symbol. Every match uses distance 12. Length symbol 285 carries the 16-bit value `length - 3`; distance symbol 6 carries the two-bit value 3. The end-of-block bits share the last compressed byte with the final match. The packed stream is:

```text
9b3061c284091326bc6060506098f09281418161c228e93f7bf4ff9f3dfaffcf1efdff678ffeffb347ffffd9a3ffffecd1ff7ff6e8ff3f7bf4ff9f3dfaffcf1efdff678ffeffb301
```

The folder chains Deflate64 (`04 01 09`) into BCJ (`03 03 01 03`) with both output sizes set to 851,922 and payload CRC32 `3a56ef09`. After the final compressed byte, the decoder retains 65,534 bytes. Its next empty-input drain writes 65,532 bytes and still has two pending bytes. BCJ must retain the unconverted tail across this drain. The regression compares the complete CLI output with the reconstructed payload, using one and two threads.
