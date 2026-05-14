// Minimal CD constants required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_CDROM_H
#define ROM_WEAVER_MAME_COMPAT_CDROM_H

class cdrom_file
{
public:
    static constexpr unsigned int MAX_SECTOR_DATA = 2352;
    static constexpr unsigned int MAX_SUBCODE_DATA = 96;
    static constexpr unsigned int FRAME_SIZE = MAX_SECTOR_DATA + MAX_SUBCODE_DATA;
};

#endif
