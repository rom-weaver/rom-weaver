/* Independent wire-byte and canary checks for every possible offset modulo 8. */
#include <assert.h>
#include <string.h>
#include "rom_weaver_unaligned.h"
struct stream_state {
    const Byte *next_in;
    Byte *next_out;
    size_t avail_in, avail_out, total_in, total_out;
};
static void advance_stream(struct stream_state *lastrm, size_t in_len, size_t out_len)
{
#include "../../libarchive/patches/7zip_sdk_null_advance.replacement.txt"
}
static void check_stream_advance(void)
{
    Byte bytes[8];
    struct stream_state stream = {0};
    advance_stream(&stream, 0, 0);
    assert(stream.next_in == NULL && stream.next_out == NULL);
    assert(stream.total_in == 0 && stream.total_out == 0);
    stream.next_in = bytes; stream.next_out = bytes; stream.avail_in = 8; stream.avail_out = 8;
    advance_stream(&stream, 3, 4);
    assert(stream.next_in == bytes + 3 && stream.next_out == bytes + 4);
    assert(stream.total_in == 3 && stream.total_out == 4);
    assert(stream.avail_in == 5 && stream.avail_out == 4);
}
int main(void)
{
    Byte storage[32];
    check_stream_advance();
    const UInt64 values[] = {0, (UInt64)-1, (UInt64)0x01234567 << 32 | 0x89abcdef};
    unsigned offset, width, k, big, i;
    for (offset = 0; offset < 8; ++offset)
    for (width = 2; width <= 8; width *= 2)
    for (k = 0; k < 3; ++k)
    for (big = 0; big < 2; ++big) {
        Byte *pointer = storage + 8 + offset;
        UInt64 value = values[k];
        UInt64 mask = width == 8 ? (UInt64)-1 : ((UInt64)1 << (width * 8)) - 1;
        memset(storage, 0xa5, sizeof(storage));
        if (big) {
            if (width == 2) SetBe16(pointer, value)
            else if (width == 4) SetBe32(pointer, value)
            else SetBe64(pointer, value)
        } else {
            if (width == 2) SetUi16(pointer, value)
            else if (width == 4) SetUi32(pointer, value)
            else SetUi64(pointer, value)
        }
        for (i = 0; i < width; ++i)
            assert(pointer[i] == (Byte)(value >> (8 * (big ? width - i - 1 : i))));
        for (i = 0; i < 8 + offset; ++i) assert(storage[i] == 0xa5);
        for (i = 8 + offset + width; i < sizeof(storage); ++i) assert(storage[i] == 0xa5);
        if (big) {
            if (width == 2) assert(GetBe16_to32(pointer) == (value & mask));
            assert((width == 2 ? GetBe16(pointer) : width == 4 ? GetBe32(pointer) : GetBe64(pointer)) == (value & mask));
        } else {
            assert((width == 2 ? GetUi16(pointer) : width == 4 ? GetUi32(pointer) : GetUi64(pointer)) == (value & mask));
        }
    }
    return 0;
}
