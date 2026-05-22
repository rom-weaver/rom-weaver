#pragma once

#include <signal.h>

#if defined(__wasm__) && defined(_WASI_EMULATED_SIGNAL) \
    && !defined(__wasilibc_unmodified_upstream)
#ifndef SIG_SETMASK
#define SIG_SETMASK 2
#endif
#define sigfillset(set_ptr) (0)
#define pthread_sigmask(how, set, oset) (0)
#endif
