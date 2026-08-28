# Where identify data comes from

`identify` matches local checksums against packs that ship with ROMWeaver. It never sends a checksum, file name, platform, or title to a lookup service.

<!-- START doctoc -->
## Table of contents

- [Primary and fallback data](#primary-and-fallback-data)
- [Source precedence](#source-precedence)
- [Legacy variants](#legacy-variants)
- [Licensing](#licensing)
- [Local operation](#local-operation)
- [Related](#related)

<!-- END doctoc -->

## Primary and fallback data

[Libretro Database](https://github.com/libretro/libretro-database) supplies the primary metadata. ROMWeaver builds from an exact repository commit.

[OpenGood](https://github.com/SnowflakePowered/opengood) supplies historical GoodTools variants that Libretro does not know. ROMWeaver also pins this source to an exact commit.

## Source precedence

ROMWeaver compares records by the hash algorithm, normalized hash, file size, and hash scope. Libretro owns the title, region, and revision when both sources contain the same record.

An overlap has one lookup record. Its provenance lists both sources. OpenGood adds a record only when its hash key is absent from Libretro.

## Legacy variants

An OpenGood-only record has `legacy_variant: true`. It keeps its GoodTools tags, such as verified dumps, bad dumps, overdumps, hacks, and trainers.

The tags describe the historical dump. They do not replace the title or change source precedence.

## Licensing

Libretro Database uses CC-BY-SA-4.0. OpenGood uses CC0-1.0. The generated identify artifacts remain separate from the application license.

Each RWFP3 manifest records each source name, URL, commit, license, and generation date. Each match also keeps the provenance that contributed its lookup record.

## Local operation

Release packages include the default pack groups. Optional groups ship as separate application assets.

The webapp precaches the default groups. A user can install a complete optional group from Settings.

Identification reads only installed application assets. A missing local pack makes identification unavailable. It does not start a network lookup.

## Related

- [Identify and hash ROMs from the CLI](../how-to/identify-and-hash-files.md)
- [CLI reference](../reference/cli.md#identify)
- [ROM identify data](../development/identify-data.md)
- [Why your files stay on your device](local-first.md)
