// Pinned eSpeak-NG 1.52.0.1, synchronous phoneme-only configuration.
#define HAVE_MKSTEMP 1
#define USE_ASYNC 0
#define USE_KLATT 0
#define USE_LIBPCAUDIO 0
#define USE_LIBSONIC 0
#define USE_MBROLA 0
#define USE_SPEECHPLAYER 0
#define PACKAGE_VERSION "1.52.0.1"

// Darwin headers do not guarantee the BSD le*toh aliases used by spect.c.
// Keep this adapter iOS-only; upstream source and Android configuration stay pinned.
#if defined(__APPLE__)
#include <libkern/OSByteOrder.h>
#ifndef le16toh
#define le16toh(x) OSSwapLittleToHostInt16(x)
#endif
#ifndef le32toh
#define le32toh(x) OSSwapLittleToHostInt32(x)
#endif
#endif
