/* Repository-owned compatibility layer; the SDK snapshot remains verbatim.
 * Hardware support for unaligned loads does not make a misaligned UInt32*
 * dereference valid C. In particular LzmaEnc_WriteProperties uses props + 1.
 * Byte accesses preserve the wire format without alignment or aliasing UB.
 * Compilers fold these fixed-width accesses into native unaligned operations
 * when the target supports them. Apply to every SDK translation unit.
 */
#ifndef ROM_WEAVER_UNALIGNED_H
#define ROM_WEAVER_UNALIGNED_H
/* cc-rs also force-includes this header in preprocessed ARM64 assembly. */
#ifndef __ASSEMBLER__
#include "Precomp.h"
#include "CpuArch.h"

#ifdef _MSC_VER
#define RW_INLINE static __inline
#else
#define RW_INLINE static inline
#endif
RW_INLINE UInt64 rw_get_le(const void *pointer, unsigned size)
{
    const Byte *bytes = (const Byte *)pointer;
    UInt64 value = 0;
    unsigned i;
    for (i = 0; i < size; ++i) value |= (UInt64)bytes[i] << (8 * i);
    return value;
}
RW_INLINE UInt64 rw_get_be(const void *pointer, unsigned size)
{
    const Byte *bytes = (const Byte *)pointer;
    UInt64 value = 0;
    unsigned i;
    for (i = 0; i < size; ++i) value = (value << 8) | bytes[i];
    return value;
}
RW_INLINE void rw_set_le(void *pointer, UInt64 value, unsigned size)
{
    Byte *bytes = (Byte *)pointer;
    unsigned i;
    for (i = 0; i < size; ++i) { bytes[i] = (Byte)value; value >>= 8; }
}
RW_INLINE void rw_set_be(void *pointer, UInt64 value, unsigned size)
{
    Byte *bytes = (Byte *)pointer;
    unsigned i;
    for (i = size; i > 0; --i) { bytes[i - 1] = (Byte)value; value >>= 8; }
}
#undef GetUi16
#undef GetUi32
#undef GetUi64
#undef SetUi16
#undef SetUi32
#undef SetUi64
#undef GetBe16
#undef GetBe16_to32
#undef GetBe32
#undef GetBe64
#undef SetBe16
#undef SetBe32
#undef SetBe64
#define GetUi16(p) ((UInt16)rw_get_le((p), 2))
#define GetUi32(p) ((UInt32)rw_get_le((p), 4))
#define GetUi64(p) rw_get_le((p), 8)
#define SetUi16(p, v) { rw_set_le((p), (UInt16)(v), 2); }
#define SetUi32(p, v) { rw_set_le((p), (UInt32)(v), 4); }
#define SetUi64(p, v) { rw_set_le((p), (UInt64)(v), 8); }
#define GetBe16(p) ((UInt16)rw_get_be((p), 2))
#define GetBe16_to32(p) ((UInt32)rw_get_be((p), 2))
#define GetBe32(p) ((UInt32)rw_get_be((p), 4))
#define GetBe64(p) rw_get_be((p), 8)
#define SetBe16(p, v) { rw_set_be((p), (UInt16)(v), 2); }
#define SetBe32(p, v) { rw_set_be((p), (UInt32)(v), 4); }
#define SetBe64(p, v) { rw_set_be((p), (UInt64)(v), 8); }
#undef RW_INLINE
#endif /* !__ASSEMBLER__ */
#endif
