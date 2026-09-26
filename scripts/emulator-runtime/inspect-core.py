import ctypes
import json
import sys


class SystemInfo(ctypes.Structure):
    _fields_ = [
        ("library_name", ctypes.c_char_p),
        ("library_version", ctypes.c_char_p),
        ("valid_extensions", ctypes.c_char_p),
        ("need_fullpath", ctypes.c_bool),
        ("block_extract", ctypes.c_bool),
    ]


core = ctypes.CDLL(sys.argv[1])
core.retro_get_system_info.argtypes = [ctypes.POINTER(SystemInfo)]
info = SystemInfo()
core.retro_get_system_info(ctypes.byref(info))
print(json.dumps({
    "name": info.library_name.decode(),
    "version": info.library_version.decode(),
    "extensions": (info.valid_extensions or b"").decode().split("|"),
}))
